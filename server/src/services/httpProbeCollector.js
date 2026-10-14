
import { randomUUID } from "node:crypto";
import { DEFAULT_SERVICES } from "../config/services.js";
import { loadHealthEndpoints } from "../config/healthEndpoints.js";
import Metric from "../models/Metric.js";
import Service from "../models/Service.js";
import { REALTIME_EVENTS } from "../realtime/events.js";
import { emitRealtimeEvent } from "../realtime/socketServer.js";
import { logger } from "../utils/logger.js";
import { applyProbeResult } from "./serviceOperations.js";
import { probeHttpEndpoint } from "./httpProbe.js";

let singletonCollector;

export function createHttpProbeCollector({
  config,
  endpoints,
  serviceModel = Service,
  metricModel = Metric,
  probe = probeHttpEndpoint,
  applyResult = applyProbeResult,
  emit = emitRealtimeEvent,
  log = logger,
  clock = () => new Date(),
  allowLocalHttp = false
}) {
  if (
    !config ||
    !Number.isSafeInteger(config.samplingIntervalMs) ||
    config.samplingIntervalMs < 1 ||
    !Number.isSafeInteger(config.retentionMs) ||
    config.retentionMs < 1 ||
    !Number.isSafeInteger(config.probeTimeoutMs) ||
    config.probeTimeoutMs < 1
  ) {
    throw new Error("A valid HTTP probe configuration is required.");
  }

  const activeServices = new Set();
  let timer;
  let activeCycle;
  let stopped = false;

  async function probeService(service) {
    if (activeServices.has(service._id)) {
      return { persisted: 0, skipped: 1, failed: 0 };
    }

    activeServices.add(service._id);
    const endpoint = endpoints.get(service._id);
    const measuredAt = clock();

    try {
      let result;

      try {
        result = endpoint
          ? await probe({
              endpoint,
              timeoutMs: config.probeTimeoutMs,
              allowLocalHttp,
              measuredAt
            })
          : {
              outcome: "unconfigured",
              failureCategory: "unconfigured",
              latencyMs: null,
              httpStatusCode: null,
              measuredAt
            };

        if (result.outcome !== "success" && result.outcome !== "unconfigured") {
          log.warn("metrics.http_probe_result", {
            serviceId: service._id,
            outcome: result.outcome,
            failureCategory: result.failureCategory ?? null,
            errorName: result.errorName ?? null,
            errorCode: result.errorCode ?? null,
            errorMessage: result.errorMessage ?? null,
            httpStatusCode: result.httpStatusCode ?? null
          });
        }
      } catch (error) {
        log.error("metrics.http_probe_failed", {
          serviceId: service._id,
          errorName: error.name || "Error",
          errorCode: error.code || error.cause?.code || null,
          errorMessage: error.message || error.cause?.message || null
        });

        result = {
          outcome: "connection_error",
          failureCategory: "connection_error",
          latencyMs: null,
          httpStatusCode: null,
          measuredAt
        };
      }

      const sampleTime = result.measuredAt || measuredAt;

      const metric = await metricModel.create({
        _id: randomUUID(),
        serviceId: service._id,
        measuredAt: sampleTime,
        latencyMs:
          typeof result.latencyMs === "number" &&
          Number.isFinite(result.latencyMs) &&
          result.latencyMs >= 0
            ? result.latencyMs
            : null,
        status:
          result.outcome === "success"
            ? "healthy"
            : result.outcome === "unconfigured"
              ? "unconfigured"
              : "degraded",
        source: "http_probe",
        outcome: result.outcome,
        httpStatusCode: result.httpStatusCode ?? null,
        failureCategory: result.failureCategory ?? null,
        samplingIntervalMs: config.samplingIntervalMs,
        expiresAt: new Date(
          sampleTime.getTime() + config.retentionMs
        )
      });

      try {
        await applyResult(service._id, result, config);
      } catch (error) {
        log.error("metrics.probe_state_update_failed", {
          serviceId: service._id,
          metricId: metric._id,
          errorName: error.name || "Error",
          errorCode: error.code || error.cause?.code || null,
          errorMessage: error.message || error.cause?.message || null
        });
      }

      try {
        emit(REALTIME_EVENTS.METRICS_SAMPLE, {
          eventId: metric._id,
          timestamp: metric.measuredAt.toISOString(),
          serviceId: metric.serviceId,
          latencyMs: metric.latencyMs,
          status: metric.status,
          source: metric.source,
          outcome: metric.outcome,
          httpStatusCode: metric.httpStatusCode,
          failureCategory: metric.failureCategory
        });
      } catch (error) {
        log.error("metrics.event_emit_failed", {
          serviceId: service._id,
          metricId: metric._id,
          errorName: error.name || "Error"
        });
      }

      return { persisted: 1, skipped: 0, failed: 0 };
    } catch (error) {
      log.error("metrics.sample_persist_failed", {
        serviceId: service._id,
        errorName: error.name || "Error",
        errorCode: error.code || error.cause?.code || null,
        errorMessage: error.message || error.cause?.message || null
      });

      return { persisted: 0, skipped: 0, failed: 1 };
    } finally {
      activeServices.delete(service._id);
    }
  }

  async function collect() {
    let services;

    try {
      services = await serviceModel
        .find({
          _id: {
            $in: DEFAULT_SERVICES.map(({ id }) => id)
          }
        })
        .select("_id")
        .lean();
    } catch (error) {
      log.error("metrics.probe_service_query_failed", {
        errorName: error.name || "Error",
        errorCode: error.code || error.cause?.code || null,
        errorMessage: error.message || error.cause?.message || null
      });

      return { persisted: 0, skipped: 0, failed: 1 };
    }

    const results = await Promise.all(
      services.map(probeService)
    );

    return results.reduce(
      (summary, result) => ({
        persisted: summary.persisted + result.persisted,
        skipped: summary.skipped + result.skipped,
        failed: summary.failed + result.failed
      }),
      { persisted: 0, skipped: 0, failed: 0 }
    );
  }

  function collectOnce() {
    if (activeCycle) return activeCycle;

    const cycle = collect();
    activeCycle = cycle;

    cycle.then(
      () => {
        if (activeCycle === cycle) activeCycle = undefined;
      },
      () => {
        if (activeCycle === cycle) activeCycle = undefined;
      }
    );

    return cycle;
  }

  async function setConfigurationState() {
    await serviceModel.updateMany(
      {
        _id: {
          $in: DEFAULT_SERVICES.map(({ id }) => id)
        }
      },
      [
        {
          $set: {
            probeConfigured: {
              $in: ["$_id", [...endpoints.keys()]]
            },
            probeStatus: {
              $cond: [
                { $in: ["$_id", [...endpoints.keys()]] },
                { $ifNull: ["$probeStatus", "unknown"] },
                "unconfigured"
              ]
            }
          }
        }
      ],
      { updatePipeline: true }
    );
  }

  async function start() {
    if (stopped) {
      throw new Error("A stopped HTTP probe collector cannot restart.");
    }

    if (timer) return false;

    await setConfigurationState();
    void collectOnce();

    timer = setInterval(() => {
      if (activeCycle) return;
      void collectOnce();
    }, config.samplingIntervalMs);

    timer.unref?.();
    return true;
  }

  async function stop() {
    stopped = true;

    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }

    if (activeCycle) await activeCycle;
  }

  return { collectOnce, start, stop };
}

export async function startHttpProbeCollection(config, endpoints) {
  if (!config.enabled) {
    logger.info("metrics.collection_disabled");
    return undefined;
  }

  if (singletonCollector) return singletonCollector;

  const configuredEndpoints = endpoints || loadHealthEndpoints();

  singletonCollector = createHttpProbeCollector({
    config,
    endpoints: configuredEndpoints,
    allowLocalHttp:
      process.env.HEALTH_ALLOW_LOCAL_HTTP?.toLowerCase() === "true" &&
      process.env.NODE_ENV === "development"
  });

  await singletonCollector.start();

  logger.info("metrics.http_probe_collection_started", {
    samplingIntervalMs: config.samplingIntervalMs,
    configuredServiceCount: configuredEndpoints.size
  });

  return singletonCollector;
}

export async function stopHttpProbeCollection() {
  if (!singletonCollector) return;

  const collector = singletonCollector;
  singletonCollector = undefined;

  await collector.stop();

  logger.info("metrics.http_probe_collection_stopped");
}