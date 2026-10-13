import { randomUUID } from "node:crypto";
import Metric from "../models/Metric.js";
import Service from "../models/Service.js";
import { DEFAULT_SERVICES } from "../config/services.js";
import { REALTIME_EVENTS } from "../realtime/events.js";
import { emitRealtimeEvent } from "../realtime/socketServer.js";
import { logger } from "../utils/logger.js";

let singletonCollector;

export function createMetricsCollector({
  config,
  serviceModel = Service,
  metricModel = Metric,
  emit = emitRealtimeEvent,
  log = logger,
  clock = () => new Date()
}) {
  if (
    !config ||
    !Number.isSafeInteger(config.samplingIntervalMs) ||
    config.samplingIntervalMs < 1 ||
    !Number.isSafeInteger(config.retentionMs) ||
    config.retentionMs < 1
  ) {
    throw new Error("A valid metrics collection configuration is required.");
  }

  let timer;
  let activeCycle;
  let stopped = false;

  async function collect() {
    let services;
    try {
      services = await serviceModel
        .find({ _id: { $in: DEFAULT_SERVICES.map((service) => service.id) } })
        .select("_id status latency")
        .lean();
    } catch (error) {
      log.error("metrics.sampling_query_failed", {
        errorName: error.name || "Error"
      });
      return { persisted: 0, failed: 1 };
    }

    let persisted = 0;
    let failed = 0;
    for (const service of services) {
      const measuredAt = clock();
      const metric = {
        _id: randomUUID(),
        serviceId: service._id,
        measuredAt,
        latencyMs: service.latency,
        status: service.status,
        source: "simulated",
        samplingIntervalMs: config.samplingIntervalMs,
        expiresAt: new Date(measuredAt.getTime() + config.retentionMs)
      };

      try {
        const savedMetric = await metricModel.create(metric);
        persisted += 1;
        try {
          emit(REALTIME_EVENTS.METRICS_SAMPLE, {
            eventId: savedMetric._id,
            timestamp: savedMetric.measuredAt.toISOString(),
            serviceId: savedMetric.serviceId,
            latencyMs: savedMetric.latencyMs,
            status: savedMetric.status,
            source: savedMetric.source
          });
        } catch (error) {
          log.error("metrics.event_emit_failed", {
            serviceId: service._id,
            metricId: savedMetric._id,
            errorName: error.name || "Error"
          });
        }
      } catch (error) {
        failed += 1;
        log.error("metrics.sample_persist_failed", {
          serviceId: service._id,
          errorName: error.name || "Error"
        });
      }
    }

    return { persisted, failed };
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

  function start() {
    if (stopped) throw new Error("A stopped metrics collector cannot restart.");
    if (timer) return false;

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

export function startMetricsCollection(config) {
  if (!config.enabled) {
    logger.info("metrics.collection_disabled");
    return undefined;
  }
  if (singletonCollector) return singletonCollector;

  singletonCollector = createMetricsCollector({ config });
  singletonCollector.start();
  logger.info("metrics.collection_started", {
    samplingIntervalMs: config.samplingIntervalMs,
    retentionDays: config.retentionDays
  });
  return singletonCollector;
}

export async function stopMetricsCollection() {
  if (!singletonCollector) return;
  const collector = singletonCollector;
  singletonCollector = undefined;
  await collector.stop();
  logger.info("metrics.collection_stopped");
}
