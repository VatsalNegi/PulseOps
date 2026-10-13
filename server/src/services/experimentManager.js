import { randomUUID } from "node:crypto";
import Experiment from "../models/Experiment.js";
import Service from "../models/Service.js";
import HttpError from "../utils/HttpError.js";
import { logger } from "../utils/logger.js";
import { emitRealtimeEvent, REALTIME_EVENTS } from "../realtime/index.js";
import {
  recoverService,
  simulateServiceFailure,
  withServiceOperation
} from "./serviceOperations.js";

const MAX_DURATION_SECONDS = 60;
let activeManager;

function serializeExperiment(experiment) {
  return {
    id: experiment._id,
    serviceId: experiment.serviceId,
    type: experiment.type,
    durationSeconds: experiment.durationSeconds,
    status: experiment.status,
    createdAt: experiment.createdAt?.toISOString() ?? null,
    startedAt: experiment.startedAt?.toISOString() ?? null,
    endsAt: experiment.endsAt?.toISOString() ?? null,
    completedAt: experiment.completedAt?.toISOString() ?? null,
    outcome: experiment.outcome
  };
}

function emitExperiment(experiment) {
  emitRealtimeEvent(REALTIME_EVENTS.EXPERIMENT_UPDATED, {
    eventId: randomUUID(),
    experiment: serializeExperiment(experiment)
  });
}

function createManager() {
  const timers = new Map();
  const finishing = new Map();
  let stopped = false;

  async function setTerminal(experimentId, status, outcome) {
    const experiment = await Experiment.findOneAndUpdate(
      { _id: experimentId, status: { $in: ["pending", "running"] } },
      {
        $set: {
          status,
          completedAt: new Date(),
          outcome
        },
        $unset: { activeServiceId: 1 }
      },
      { returnDocument: "after" }
    );
    if (experiment) emitExperiment(experiment);
    return experiment;
  }

  function complete(experimentId, status, outcome) {
    if (finishing.has(experimentId)) return finishing.get(experimentId);
    const operation = (async () => {
      const experiment = await Experiment.findOne({
        _id: experimentId,
        status: "running"
      });
      if (!experiment) return null;

      const timer = timers.get(experimentId);
      if (timer) {
        clearTimeout(timer);
        timers.delete(experimentId);
      }

      try {
        await recoverService(experiment.serviceId, { experimentId });
      } catch (error) {
        await setTerminal(
          experimentId,
          "failed",
          "Recovery failed; service ownership was retained for safe manual recovery."
        );
        logger.error("experiment.recovery_failed", {
          experimentId,
          serviceId: experiment.serviceId,
          errorName: error.name || "Error"
        });
        throw error;
      }

      return setTerminal(experimentId, status, outcome);
    })();
    finishing.set(experimentId, operation);
    operation.then(
      () => {
        if (finishing.get(experimentId) === operation) {
          finishing.delete(experimentId);
        }
      },
      () => {
        if (finishing.get(experimentId) === operation) {
          finishing.delete(experimentId);
        }
      }
    );
    return operation;
  }

  function schedule(experiment) {
    const remaining = Math.max(
      0,
      experiment.endsAt.getTime() - Date.now()
    );
    const timer = setTimeout(() => {
      timers.delete(experiment._id);
      void complete(
        experiment._id,
        "completed",
        "Simulated failure ended and the service was recovered."
      ).catch((error) => {
        logger.error("experiment.completion_failed", {
          experimentId: experiment._id,
          serviceId: experiment.serviceId,
          errorName: error.name || "Error"
        });
      });
    }, remaining);
    timer.unref?.();
    timers.set(experiment._id, timer);
  }

  async function start(experimentId) {
    const experiment = await Experiment.findOne({
      _id: experimentId,
      status: "pending"
    });
    if (!experiment) throw new HttpError(404, "Experiment not found");

    const claimedService = await withServiceOperation(
      experiment.serviceId,
      () =>
        Service.findOneAndUpdate(
          {
            _id: experiment.serviceId,
            status: "healthy",
            activeExperimentId: null
          },
          { $set: { activeExperimentId: experiment._id } },
          { returnDocument: "after" }
        )
    );
    if (!claimedService) {
      const failed = await setTerminal(
        experimentId,
        "failed",
        "Service was not healthy or was already owned by another operation."
      );
      if (!failed) throw new HttpError(409, "Experiment could not be started");
      throw new HttpError(409, "Service is not available for an experiment");
    }

    const startedAt = new Date();
    const endsAt = new Date(
      startedAt.getTime() + experiment.durationSeconds * 1000
    );
    const running = await Experiment.findOneAndUpdate(
      { _id: experimentId, status: "pending" },
      { $set: { status: "running", startedAt, endsAt } },
      { returnDocument: "after" }
    );
    if (!running) {
      await recoverService(experiment.serviceId, { experimentId });
      throw new HttpError(409, "Experiment state changed before it started");
    }

    emitExperiment(running);
    try {
      await simulateServiceFailure(experiment.serviceId, { experimentId });
    } catch (error) {
      try {
        await recoverService(experiment.serviceId, { experimentId });
      } catch (recoveryError) {
        logger.error("experiment.start_compensation_failed", {
          experimentId,
          serviceId: experiment.serviceId,
          errorName: recoveryError.name || "Error"
        });
      }
      await setTerminal(
        experimentId,
        "failed",
        "The simulated failure could not be started."
      );
      throw error;
    }

    schedule(running);
    return Experiment.findById(experimentId);
  }

  async function create({ serviceId, durationSeconds }) {
    if (
      typeof serviceId !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(serviceId)
    ) {
      throw new HttpError(400, "Invalid service ID");
    }
    if (!Number.isInteger(durationSeconds) || durationSeconds < 1 ||
        durationSeconds > MAX_DURATION_SECONDS) {
      throw new HttpError(
        400,
        `durationSeconds must be a whole number between 1 and ${MAX_DURATION_SECONDS}`
      );
    }
    const service = await Service.findById(serviceId).lean();
    if (!service) throw new HttpError(404, "Service not found");

    const id = randomUUID();
    let experiment;
    try {
      experiment = await Experiment.create({
        _id: id,
        serviceId,
        activeServiceId: serviceId,
        type: "simulated_service_failure",
        durationSeconds,
        status: "pending",
        createdAt: new Date(),
        startedAt: null,
        endsAt: null,
        completedAt: null,
        outcome: null
      });
    } catch (error) {
      if (error.code === 11000) {
        throw new HttpError(
          409,
          "An experiment is already active for this service"
        );
      }
      throw error;
    }
    emitExperiment(experiment);

    return start(id);
  }

  async function cancel(experimentId) {
    const experiment = await Experiment.findById(experimentId);
    if (!experiment) throw new HttpError(404, "Experiment not found");
    if (experiment.status !== "running") {
      throw new HttpError(409, "Only a running experiment can be cancelled");
    }
    const result = await complete(
      experimentId,
      "cancelled",
      "Experiment was cancelled and the service was recovered."
    );
    if (result?.status !== "cancelled") {
      throw new HttpError(409, "Experiment completed before it could be cancelled");
    }
    return result;
  }

  async function restore() {
    const active = await Experiment.find({
      status: { $in: ["pending", "running"] }
    }).limit(3);
    for (const experiment of active) {
      const service = await Service.findById(experiment.serviceId).lean();
      const ownsService = service?.activeExperimentId === experiment._id;

      if (experiment.status === "pending") {
        if (ownsService) {
          try {
            await recoverService(experiment.serviceId, {
              experimentId: experiment._id
            });
          } catch (error) {
            logger.error("experiment.startup_recovery_failed", {
              experimentId: experiment._id,
              serviceId: experiment.serviceId,
              errorName: error.name || "Error"
            });
          }
        }
        await setTerminal(
          experiment._id,
          "failed",
          "Experiment was interrupted before execution could be confirmed."
        );
        continue;
      }

      if (!ownsService) {
        await setTerminal(
          experiment._id,
          "failed",
          "Experiment was interrupted and no longer owns the service."
        );
        continue;
      }
      if (!experiment.endsAt || experiment.endsAt <= new Date()) {
        await complete(
          experiment._id,
          "completed",
          "Simulated failure ended and the service was recovered after restart."
        );
      } else {
        schedule(experiment);
      }
    }
  }

  async function stop() {
    stopped = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    const active = await Experiment.find({
      status: { $in: ["pending", "running"] }
    }).limit(3);
    for (const experiment of active) {
      if (experiment.status === "running") {
        try {
          await complete(
            experiment._id,
            "failed",
            "Experiment was safely stopped during server shutdown."
          );
        } catch {
          try {
            await setTerminal(
              experiment._id,
              "failed",
              "Recovery failed during server shutdown; service ownership was retained."
            );
          } catch (error) {
            logger.error("experiment.shutdown_cleanup_failed", {
              experimentId: experiment._id,
              serviceId: experiment.serviceId,
              errorName: error.name || "Error"
            });
          }
        }
      } else {
        try {
          await setTerminal(
            experiment._id,
            "failed",
            "Experiment was stopped before execution during server shutdown."
          );
        } catch (error) {
          logger.error("experiment.shutdown_cleanup_failed", {
            experimentId: experiment._id,
            serviceId: experiment.serviceId,
            errorName: error.name || "Error"
          });
        }
      }
    }
    await Promise.allSettled([...finishing.values()]);
  }

  return { create, cancel, restore, stop, isStopped: () => stopped };
}

export async function startExperimentManager() {
  if (activeManager) return;
  activeManager = createManager();
  await activeManager.restore();
}

export async function stopExperimentManager() {
  if (!activeManager) return;
  const manager = activeManager;
  activeManager = undefined;
  await manager.stop();
}

function getManager() {
  if (!activeManager || activeManager.isStopped()) {
    throw new HttpError(503, "Experiment execution is not available");
  }
  return activeManager;
}

export function createExperiment(input) {
  return getManager().create(input);
}

export function cancelExperiment(experimentId) {
  return getManager().cancel(experimentId);
}

export { serializeExperiment };
