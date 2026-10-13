import { randomUUID } from "node:crypto";
import Incident from "../models/Incident.js";
import Service from "../models/Service.js";
import { NORMAL_LATENCY } from "../config/services.js";
import HttpError from "../utils/HttpError.js";
import { logger } from "../utils/logger.js";
import { emitRealtimeEvent, REALTIME_EVENTS } from "../realtime/index.js";
import Experiment from "../models/Experiment.js";

const serviceOperationQueues = new Map();

export function serializeService(service) {
  return {
    id: service._id,
    name: service.name,
    status: service.status,
    latency: service.latency,
    probeConfigured: service.probeConfigured ?? false,
    probeStatus: service.probeStatus ?? "unconfigured",
    lastProbeAt: service.lastProbeAt?.toISOString() ?? null,
    lastProbeOutcome: service.lastProbeOutcome ?? "unconfigured",
    lastProbeLatencyMs: service.lastProbeLatencyMs ?? null,
    lastProbeHttpStatus: service.lastProbeHttpStatus ?? null
  };
}

export function serializeIncident(incident) {
  return {
    id: incident._id,
    serviceId: incident.serviceId,
    serviceName: incident.serviceName,
    title: incident.title,
    description: incident.description,
    source: incident.source ?? "simulator",
    severity: incident.severity,
    status: incident.status,
    createdAt: incident.createdAt.toISOString(),
    resolvedAt: incident.resolvedAt?.toISOString() ?? null
  };
}

export async function withServiceOperation(serviceId, operation) {
  const previousOperation =
    serviceOperationQueues.get(serviceId) || Promise.resolve();
  let releaseOperation;
  const currentOperation = new Promise((resolve) => {
    releaseOperation = resolve;
  });

  serviceOperationQueues.set(serviceId, currentOperation);
  await previousOperation;

  try {
    return await operation();
  } finally {
    releaseOperation();
    if (serviceOperationQueues.get(serviceId) === currentOperation) {
      serviceOperationQueues.delete(serviceId);
    }
  }
}

async function createIncident(
  service,
  source = "simulator",
  description = `Response latency increased to ${service.latency} ms.`
) {
  const existingIncident = await Incident.findOne({
    serviceId: service._id,
    status: "open"
  });
  if (existingIncident) return existingIncident;

  const incident = new Incident({
    _id: randomUUID(),
    serviceId: service._id,
    serviceName: service.name,
    title: `${service.name} is degraded`,
    description,
    source,
    severity: service.latency >= 3000 ? "critical" : "warning",
    status: "open",
    createdAt: new Date(),
    resolvedAt: null
  });

  try {
    const savedIncident = await incident.save();
    emitRealtimeEvent(REALTIME_EVENTS.INCIDENT_CREATED, {
      eventId: randomUUID(),
      occurredAt: savedIncident.createdAt.toISOString(),
      service: serializeService(service),
      incident: serializeIncident(savedIncident)
    });
    logger.info("incident.created", {
      serviceId: service._id,
      incidentId: savedIncident._id
    });
    return savedIncident;
  } catch (error) {
    if (error.code !== 11000) throw error;
    const duplicate = await Incident.findOne({
      serviceId: service._id,
      status: "open"
    });
    if (duplicate) return duplicate;
    throw error;
  }
}

async function resolveIncident(serviceId, source) {
  return Incident.findOneAndUpdate(
    { serviceId, status: "open", ...(source ? { source } : {}) },
    { $set: { status: "resolved", resolvedAt: new Date() } },
    { returnDocument: "after" }
  );
}

export function applyProbeResult(serviceId, result, config) {
  return withServiceOperation(serviceId, async () => {
    const current = await Service.findById(serviceId);
    if (!current) return { changed: false, reason: "service_missing" };

    const observedAt = result.measuredAt;
    const fields = {
      lastProbeAt: observedAt,
      lastProbeOutcome: result.outcome,
      lastProbeHttpStatus: result.httpStatusCode ?? null,
      lastProbeLatencyMs: result.latencyMs ?? null
    };
    const ownedByExperiment = Boolean(current.activeExperimentId);
    const priorStatus = current.probeStatus || "unconfigured";

    if (result.outcome === "unconfigured" || result.outcome === "unsafe_endpoint") {
      await Service.updateOne({ _id: serviceId }, {
        $set: {
          ...fields,
          probeStatus:
            result.outcome === "unconfigured" ? "unconfigured" : "unknown"
        }
      });
      return { changed: false, reason: result.outcome };
    }

    if (result.outcome === "success") {
      await Service.updateOne({ _id: serviceId }, {
        $set: fields,
        $inc: { probeSuccessCount: 1 }
      });
      const updated = await Service.findById(serviceId);
      if (ownedByExperiment) return { changed: false, reason: "experiment_owned" };
      if (
        priorStatus !== "degraded" ||
        updated.probeSuccessCount < config.recoveryThreshold
      ) {
        if (priorStatus !== "degraded") {
          await Service.updateOne(
            { _id: serviceId },
            { $set: { probeStatus: "healthy", probeFailureCount: 0 } }
          );
          if (priorStatus !== "healthy") {
            emitRealtimeEvent(REALTIME_EVENTS.SERVICE_PROBE_UPDATED, {
              eventId: randomUUID(),
              occurredAt: observedAt.toISOString(),
              serviceId,
              status: "healthy",
              outcome: result.outcome,
              httpStatusCode: result.httpStatusCode
            });
          }
        }
        return { changed: priorStatus !== "healthy", status: "healthy" };
      }

      const incident = await resolveIncident(serviceId, "http_probe");
      if (incident) {
        emitRealtimeEvent(REALTIME_EVENTS.INCIDENT_RESOLVED, {
          eventId: randomUUID(),
          occurredAt: incident.resolvedAt.toISOString(),
          service: serializeService(updated),
          incident: serializeIncident(incident)
        });
      }
      await Service.updateOne(
        { _id: serviceId },
        { $set: { probeStatus: "healthy", probeFailureCount: 0 } }
      );
      emitRealtimeEvent(REALTIME_EVENTS.SERVICE_PROBE_UPDATED, {
        eventId: randomUUID(),
        occurredAt: observedAt.toISOString(),
        serviceId,
        status: "healthy",
        outcome: result.outcome,
        httpStatusCode: result.httpStatusCode
      });
      return { changed: true, status: "healthy" };
    }

    await Service.updateOne({ _id: serviceId }, {
      $set: fields,
      $inc: { probeFailureCount: 1 }
    });
    const updated = await Service.findById(serviceId);
    if (ownedByExperiment) return { changed: false, reason: "experiment_owned" };
    if (updated.probeFailureCount < config.failureThreshold) {
      if (priorStatus === "unconfigured") {
        await Service.updateOne(
          { _id: serviceId },
          { $set: { probeStatus: "unknown" } }
        );
      }
      return { changed: false, reason: "below_failure_threshold" };
    }

    const incident = await createIncident(
      updated,
      "http_probe",
      `Health probe failed ${updated.probeFailureCount} consecutive times (${result.outcome}).`
    );
    await Service.updateOne(
      { _id: serviceId },
      { $set: { probeStatus: "degraded", probeSuccessCount: 0 } }
    );
    if (priorStatus !== "degraded") {
      emitRealtimeEvent(REALTIME_EVENTS.SERVICE_PROBE_UPDATED, {
        eventId: randomUUID(),
        occurredAt: observedAt.toISOString(),
        serviceId,
        status: "degraded",
        outcome: result.outcome,
        httpStatusCode: result.httpStatusCode ?? null,
        incident:
          incident.source === "http_probe"
            ? serializeIncident(incident)
            : null
      });
    }
    return { changed: priorStatus !== "degraded", status: "degraded" };
  });
}

export function simulateServiceFailure(
  serviceId,
  { experimentId = null, requestId } = {}
) {
  return withServiceOperation(serviceId, async () => {
    if (!experimentId) {
      const owned = await Service.findById(serviceId).select("activeExperimentId").lean();
      if (owned?.activeExperimentId) {
        const activeExperiment = await Experiment.exists({
          _id: owned.activeExperimentId,
          status: { $in: ["pending", "running"] }
        });
        if (activeExperiment) {
          throw new HttpError(409, "Service is owned by an active experiment");
        }
      }
    }
    const ownership = experimentId;
    const service = await Service.findOneAndUpdate(
      {
        _id: serviceId,
        status: "healthy",
        activeExperimentId: ownership
      },
      { $set: { status: "degraded", latency: 5000 } },
      { returnDocument: "after" }
    );

    if (!service) {
      const currentService = await Service.findById(serviceId);
      if (!currentService) throw new HttpError(404, "Service not found");
      if (currentService.activeExperimentId !== ownership) {
        throw new HttpError(409, "Service is owned by an active experiment");
      }
      if (currentService.status === "degraded" && !experimentId) {
        return {
          alreadyDegraded: true,
          service: currentService,
          incident: null
        };
      }
      throw new HttpError(409, "Service state changed; retry the operation");
    }

    let incident;
    try {
      incident = await createIncident(service);
    } catch (error) {
      try {
        await Service.updateOne(
          {
            _id: service._id,
            status: "degraded",
            activeExperimentId: ownership
          },
          {
            $set: {
              status: "healthy",
              latency: NORMAL_LATENCY[service._id]
            }
          }
        );
      } catch (compensationError) {
        logger.error("service.failure_compensation_failed", {
          requestId,
          serviceId: service._id,
          errorName: compensationError.name || "Error"
        });
      }
      throw error;
    }

    logger.info("service.failure_simulated", {
      requestId,
      serviceId: service._id,
      incidentId: incident._id
    });
    emitRealtimeEvent(REALTIME_EVENTS.SERVICE_FAILURE, {
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      service: serializeService(service),
      incident: serializeIncident(incident)
    });
    return { alreadyDegraded: false, service, incident };
  });
}

export function recoverService(
  serviceId,
  { experimentId = null, requestId } = {}
) {
  return withServiceOperation(serviceId, async () => {
    let service = await Service.findOneAndUpdate(
      {
        _id: serviceId,
        status: "degraded",
        activeExperimentId: experimentId
      },
      {
        $set: {
          status: "healthy",
          latency: NORMAL_LATENCY[serviceId],
          activeExperimentId: null
        }
      },
      { returnDocument: "after" }
    );

    const transitioned = Boolean(service);
    if (!service) {
      service = await Service.findById(serviceId);
      if (!service) throw new HttpError(404, "Service not found");
      if (service.activeExperimentId !== experimentId) {
        throw new HttpError(409, "Service is owned by an active experiment");
      }
      if (service.status !== "healthy") {
        throw new HttpError(409, "Service state changed; retry the operation");
      }
      if (experimentId) {
        service = await Service.findOneAndUpdate(
          { _id: serviceId, status: "healthy", activeExperimentId: experimentId },
          { $set: { activeExperimentId: null } },
          { returnDocument: "after" }
        );
        if (!service) {
          throw new HttpError(409, "Service state changed; retry the operation");
        }
      }
    }

    let incident;
    try {
      incident = await resolveIncident(service._id);
    } catch (error) {
      if (transitioned) {
        try {
          await Service.updateOne(
            {
              _id: service._id,
              status: "healthy",
              activeExperimentId: null
            },
            {
              $set: {
                status: "degraded",
                latency: 5000,
                activeExperimentId: experimentId
              }
            }
          );
        } catch (compensationError) {
          logger.error("service.recovery_compensation_failed", {
            requestId,
            serviceId: service._id,
            errorName: compensationError.name || "Error"
          });
        }
      }
      throw error;
    }

    if (incident) {
      emitRealtimeEvent(REALTIME_EVENTS.INCIDENT_RESOLVED, {
        eventId: randomUUID(),
        occurredAt: incident.resolvedAt.toISOString(),
        service: serializeService(service),
        incident: serializeIncident(incident)
      });
      logger.info("incident.resolved", {
        requestId,
        serviceId: service._id,
        incidentId: incident._id
      });
    }
    logger.info("service.recovered", {
      requestId,
      serviceId: service._id,
      incidentId: incident?._id
    });
    emitRealtimeEvent(REALTIME_EVENTS.SERVICE_RECOVERED, {
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      service: serializeService(service),
      incident: incident ? serializeIncident(incident) : null
    });
    return { service, incident };
  });
}
