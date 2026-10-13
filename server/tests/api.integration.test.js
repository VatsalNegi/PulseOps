import dotenv from "dotenv";
import mongoose from "mongoose";
import request from "supertest";
import { io as createSocketClient } from "socket.io-client";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import app from "../src/app.js";
import { startServer } from "../src/server.js";
import {
  initializeDatabase,
  seedDefaultServices
} from "../src/db/initializeDatabase.js";
import Incident from "../src/models/Incident.js";
import Experiment from "../src/models/Experiment.js";
import Service from "../src/models/Service.js";
import { logger } from "../src/utils/logger.js";
import Metric from "../src/models/Metric.js";
import { loadHealthEndpoints, isPublicAddress } from "../src/config/healthEndpoints.js";
import { loadMetricsConfig } from "../src/config/metrics.js";
import {
  createMetricsCollector,
  startMetricsCollection,
  stopMetricsCollection
} from "../src/services/metricsCollector.js";
import { REALTIME_EVENTS } from "../src/realtime/events.js";
import {
  startExperimentManager,
  stopExperimentManager
} from "../src/services/experimentManager.js";
import { probeHttpEndpoint } from "../src/services/httpProbe.js";
import { createHttpProbeCollector } from "../src/services/httpProbeCollector.js";
import { applyProbeResult } from "../src/services/serviceOperations.js";

dotenv.config();

const TEST_DATABASE_NAME = "pulseops_test";
let testUri;
let originalMetricsEnabled;

const sampleConfig = {
  enabled: true,
  samplingIntervalMs: 30000,
  retentionDays: 7,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  probeTimeoutMs: 5000,
  failureThreshold: 3,
  recoveryThreshold: 2
};

function createMetricFixture(overrides = {}) {
  const measuredAt = new Date("2099-09-01T12:00:00.000Z");
  return {
    _id: randomUUID(),
    serviceId: "user-service",
    measuredAt,
    latencyMs: 45,
    status: "healthy",
    source: "simulated",
    samplingIntervalMs: sampleConfig.samplingIntervalMs,
    expiresAt: new Date(measuredAt.getTime() + sampleConfig.retentionMs),
    ...overrides
  };
}

async function withLocalHttpServer(handler, run) {
  const server = createHttpServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  try {
    return await run({
      server,
      endpoint: {
        url: `http://127.0.0.1:${address.port}/health`,
        hostname: "127.0.0.1",
        local: true
      }
    });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function validateTestUri(uri) {
  if (!uri) {
    throw new Error(
      "MONGODB_TEST_URI is required. Set it to a MongoDB URI for pulseops_test."
    );
  }

  let parsedUri;
  try {
    parsedUri = new URL(uri);
  } catch {
    throw new Error("MONGODB_TEST_URI must be a valid MongoDB connection URI.");
  }

  if (
    !["mongodb:", "mongodb+srv:"].includes(parsedUri.protocol) ||
    decodeURIComponent(parsedUri.pathname.replace(/^\/+/, "")) !==
      TEST_DATABASE_NAME
  ) {
    throw new Error(
      `MONGODB_TEST_URI must target the ${TEST_DATABASE_NAME} database.`
    );
  }

  return uri;
}

function assertSafeTestConnection() {
  if (
    mongoose.connection.readyState !== 1 ||
    mongoose.connection.name !== TEST_DATABASE_NAME
  ) {
    throw new Error(
      `Refusing test database cleanup: the active MongoDB connection is not ${TEST_DATABASE_NAME}.`
    );
  }
}

describe("PulseOps API integration", () => {
  beforeAll(async () => {
    testUri = validateTestUri(process.env.MONGODB_TEST_URI);
    originalMetricsEnabled = process.env.METRICS_ENABLED;
    process.env.METRICS_ENABLED = "false";
    await initializeDatabase(testUri);
    assertSafeTestConnection();
  });

  beforeEach(async () => {
    await stopExperimentManager();
    if (mongoose.connection.readyState !== 1) {
      await initializeDatabase(testUri);
    }
    assertSafeTestConnection();
    await Promise.all([
      Incident.deleteMany({}),
      Experiment.deleteMany({}),
      Metric.deleteMany({}),
      Service.deleteMany({})
    ]);
    await seedDefaultServices();
    await startExperimentManager();
  });

  afterAll(async () => {
    await stopExperimentManager();
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    if (originalMetricsEnabled === undefined) {
      delete process.env.METRICS_ENABLED;
    } else {
      process.env.METRICS_ENABLED = originalMetricsEnabled;
    }
  });

  it("returns the existing health response", async () => {
    const response = await request(app).get("/api/health").expect(200);

    expect(response.body).toEqual({
      success: true,
      message: "PulseOps API is running"
    });
  });

  it("creates a simulated service-failure experiment and owns service state", async () => {
    const response = await request(app)
      .post("/api/experiments")
      .send({ serviceId: "payment-service", durationSeconds: 30 })
      .expect(201);

    expect(response.body).toMatchObject({
      success: true,
      data: {
        serviceId: "payment-service",
        type: "simulated_service_failure",
        durationSeconds: 30,
        status: "running",
        outcome: null
      }
    });
    expect(response.body.data.id).toEqual(expect.any(String));
    expect(Date.parse(response.body.data.endsAt)).toBeGreaterThan(
      Date.parse(response.body.data.startedAt)
    );
    expect(await Service.findById("payment-service").lean()).toMatchObject({
      status: "degraded",
      latency: 5000,
      activeExperimentId: response.body.data.id
    });
    expect(await Incident.countDocuments({
      serviceId: "payment-service",
      status: "open"
    })).toBe(1);

    await request(app)
      .get(`/api/experiments/${response.body.data.id}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.status).toBe("running");
      });
  });

  it("validates experiment duration and monitored service", async () => {
    for (const durationSeconds of [0, 61, 1.5, "10"]) {
      await request(app)
        .post("/api/experiments")
        .send({ serviceId: "user-service", durationSeconds })
        .expect(400);
    }
    await request(app)
      .post("/api/experiments")
      .send({ serviceId: "unknown-service", durationSeconds: 10 })
      .expect(404);
    expect(await Experiment.countDocuments({})).toBe(0);
  });

  it("automatically completes an experiment and recovers the service", async () => {
    const created = await request(app)
      .post("/api/experiments")
      .send({ serviceId: "user-service", durationSeconds: 1 })
      .expect(201);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Experiment did not finish within the test bound")),
        5000
      );
      const poll = async () => {
        const experiment = await Experiment.findById(created.body.data.id).lean();
        if (experiment?.status === "completed") {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(poll, 25);
        }
      };
      void poll();
    });

    const experiment = await Experiment.findById(created.body.data.id).lean();
    expect(experiment).toMatchObject({
      status: "completed",
      outcome: "Simulated failure ended and the service was recovered."
    });
    expect(experiment.completedAt).toBeInstanceOf(Date);
    expect(await Service.findById("user-service").lean()).toMatchObject({
      status: "healthy",
      latency: 45,
      activeExperimentId: null
    });
    expect(await Incident.countDocuments({
      serviceId: "user-service",
      status: "resolved"
    })).toBe(1);
  });

  it("cancels an active experiment early and prevents duplicate ownership", async () => {
    const created = await request(app)
      .post("/api/experiments")
      .send({ serviceId: "order-service", durationSeconds: 60 })
      .expect(201);

    await request(app)
      .post("/api/experiments")
      .send({ serviceId: "order-service", durationSeconds: 10 })
      .expect(409);
    await request(app)
      .post("/api/services/order-service/recover")
      .expect(409);
    await request(app)
      .post("/api/services/order-service/failure")
      .expect(409);

    const cancelled = await request(app)
      .post(`/api/experiments/${created.body.data.id}/cancel`)
      .expect(200);
    expect(cancelled.body.data.status).toBe("cancelled");
    expect(await Service.findById("order-service").lean()).toMatchObject({
      status: "healthy",
      latency: 80,
      activeExperimentId: null
    });
    await request(app)
      .post(`/api/experiments/${created.body.data.id}/cancel`)
      .expect(409);
  });

  it("marks a failed execution and compensates service state", async () => {
    const saveSpy = vi
      .spyOn(Incident.prototype, "save")
      .mockRejectedValue(new Error("simulated incident persistence failure"));
    const loggerSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    try {
      await request(app)
        .post("/api/experiments")
        .send({ serviceId: "payment-service", durationSeconds: 20 })
        .expect(500);
    } finally {
      saveSpy.mockRestore();
      loggerSpy.mockRestore();
    }

    const experiment = await Experiment.findOne({
      serviceId: "payment-service"
    }).lean();
    expect(experiment).toMatchObject({
      status: "failed",
      outcome: "The simulated failure could not be started."
    });
    expect(await Service.findById("payment-service").lean()).toMatchObject({
      status: "healthy",
      latency: 100,
      activeExperimentId: null
    });
  });

  it("marks recovery failures and allows safe manual recovery of terminal ownership", async () => {
    const created = await request(app)
      .post("/api/experiments")
      .send({ serviceId: "order-service", durationSeconds: 60 })
      .expect(201);
    const updateSpy = vi
      .spyOn(Incident, "findOneAndUpdate")
      .mockRejectedValue(new Error("simulated resolution failure"));
    const loggerSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    try {
      await request(app)
        .post(`/api/experiments/${created.body.data.id}/cancel`)
        .expect(500);
    } finally {
      updateSpy.mockRestore();
      loggerSpy.mockRestore();
    }

    expect(await Experiment.findById(created.body.data.id).lean()).toMatchObject({
      status: "failed"
    });
    expect(await Service.findById("order-service").lean()).toMatchObject({
      status: "degraded",
      activeExperimentId: created.body.data.id
    });

    await request(app).post("/api/services/order-service/recover").expect(200);
    expect(await Service.findById("order-service").lean()).toMatchObject({
      status: "healthy",
      activeExperimentId: null
    });
  });

  it("returns recent experiment history newest first", async () => {
    await request(app)
      .post("/api/experiments")
      .send({ serviceId: "user-service", durationSeconds: 60 })
      .expect(201);
    await request(app)
      .post("/api/experiments")
      .send({ serviceId: "order-service", durationSeconds: 60 })
      .expect(201);

    const response = await request(app).get("/api/experiments").expect(200);
    expect(response.body.success).toBe(true);
    expect(response.body.count).toBe(2);
    expect(response.body.data.map((item) => item.serviceId)).toEqual([
      "order-service",
      "user-service"
    ]);
  });

  it("validates metric schema fields and persists a valid record", async () => {
    for (const invalidFields of [
      { latencyMs: -1 },
      { status: "unknown" },
      { source: "real_network" },
      { serviceId: "unknown-service" }
    ]) {
      const invalidMetric = new Metric(createMetricFixture(invalidFields));
      await expect(invalidMetric.validate()).rejects.toThrow();
    }

    const persisted = await Metric.create(createMetricFixture());
    const stored = await Metric.findById(persisted._id).lean();
    expect(stored).toMatchObject({
      serviceId: "user-service",
      latencyMs: 45,
      status: "healthy",
      source: "simulated"
    });
    expect(stored.measuredAt.toISOString()).toBe(
      "2099-09-01T12:00:00.000Z"
    );
  });

  it("loads documented sampling defaults and validates metric configuration", () => {
    expect(loadMetricsConfig({})).toEqual({
      enabled: true,
      samplingIntervalMs: 30000,
      retentionDays: 7,
      retentionMs: sampleConfig.retentionMs,
      probeTimeoutMs: 5000,
      failureThreshold: 3,
      recoveryThreshold: 2
    });
    expect(
      loadMetricsConfig({
        METRICS_ENABLED: "false",
        METRICS_SAMPLING_INTERVAL_MS: "60000",
        METRICS_RETENTION_DAYS: "2"
      })
    ).toMatchObject({
      enabled: false,
      samplingIntervalMs: 60000,
      retentionDays: 2
    });
    expect(() =>
      loadMetricsConfig({ METRICS_SAMPLING_INTERVAL_MS: "0" })
    ).toThrow("METRICS_SAMPLING_INTERVAL_MS");
    expect(() => loadMetricsConfig({ METRICS_ENABLED: "yes" })).toThrow(
      "METRICS_ENABLED"
    );
  });

  it("validates explicit service endpoints and rejects private external addresses", () => {
    expect(() =>
      loadHealthEndpoints({
        NODE_ENV: "production",
        HEALTH_ENDPOINTS_JSON: JSON.stringify({
          "user-service": "https://monitor.example/health"
        }),
        HEALTH_ALLOWED_HOSTS: "monitor.example"
      })
    ).not.toThrow();
    for (const endpoint of [
      "http://monitor.example/health",
      "https://user:secret@monitor.example/health",
      "https://unapproved.example/health",
      "https://127.0.0.1/health"
    ]) {
      expect(() =>
        loadHealthEndpoints({
          NODE_ENV: "production",
          HEALTH_ENDPOINTS_JSON: JSON.stringify({
            "user-service": endpoint
          }),
          HEALTH_ALLOWED_HOSTS: "monitor.example"
        })
      ).toThrow();
    }
    expect(
      loadHealthEndpoints({
        NODE_ENV: "development",
        HEALTH_ALLOW_LOCAL_HTTP: "true",
        HEALTH_ENDPOINTS_JSON: JSON.stringify({
          "user-service": "http://127.0.0.1:5000/health"
        })
      }).has("user-service")
    ).toBe(true);
    expect(isPublicAddress("127.0.0.1")).toBe(false);
    expect(isPublicAddress("169.254.169.254")).toBe(false);
    expect(isPublicAddress("8.8.8.8")).toBe(true);
  });

  it("measures a successful HTTP probe and records non-2xx responses", async () => {
    await withLocalHttpServer((req, res) => {
      res.statusCode = req.url === "/redirect" ? 302 : req.url === "/bad" ? 503 : 204;
      if (res.statusCode === 302) res.setHeader("Location", "/elsewhere");
      res.end();
    }, async ({ endpoint }) => {
      const success = await probeHttpEndpoint({
        endpoint,
        timeoutMs: 500,
        allowLocalHttp: true
      });
      expect(success).toMatchObject({
        outcome: "success",
        httpStatusCode: 204,
        failureCategory: null
      });
      expect(success.latencyMs).toEqual(expect.any(Number));
      expect(success.latencyMs).toBeGreaterThanOrEqual(0);

      const unhealthy = await probeHttpEndpoint({
        endpoint: { ...endpoint, url: endpoint.url.replace("/health", "/bad") },
        timeoutMs: 500,
        allowLocalHttp: true
      });
      expect(unhealthy).toMatchObject({
        outcome: "unhealthy_http_response",
        failureCategory: "unhealthy_http_response",
        httpStatusCode: 503
      });
      expect(unhealthy.latencyMs).toEqual(expect.any(Number));

      const redirect = await probeHttpEndpoint({
        endpoint: {
          ...endpoint,
          url: endpoint.url.replace("/health", "/redirect")
        },
        timeoutMs: 500,
        allowLocalHttp: true
      });
      expect(redirect).toMatchObject({
        outcome: "unhealthy_http_response",
        failureCategory: "unhealthy_http_response",
        httpStatusCode: 302
      });
    });
  });

  it("runs the real local HTTP probe through persistence, failure thresholds, and recovery", async () => {
    let statusCode = 200;
    await withLocalHttpServer((_req, res) => {
      res.statusCode = statusCode;
      res.end();
    }, async ({ endpoint }) => {
      const collector = createHttpProbeCollector({
        config: sampleConfig,
        endpoints: new Map([["user-service", endpoint]]),
        allowLocalHttp: true,
        emit: vi.fn()
      });

      await collector.collectOnce();
      const healthyMetric = await Metric.findOne({
        serviceId: "user-service",
        source: "http_probe"
      }).sort({ measuredAt: -1 }).lean();
      expect(healthyMetric).toMatchObject({
        status: "healthy",
        source: "http_probe",
        outcome: "success",
        httpStatusCode: 200
      });
      expect(healthyMetric.latencyMs).toEqual(expect.any(Number));
      expect(await Service.findById("user-service").lean()).toMatchObject({
        probeStatus: "healthy",
        lastProbeHttpStatus: 200
      });

      statusCode = 503;
      for (let attempt = 0; attempt < sampleConfig.failureThreshold; attempt += 1) {
        await collector.collectOnce();
      }
      const failedMetric = await Metric.findOne({
        serviceId: "user-service",
        source: "http_probe",
        httpStatusCode: 503
      }).sort({ measuredAt: -1 }).lean();
      expect(failedMetric).toMatchObject({
        status: "degraded",
        outcome: "unhealthy_http_response",
        failureCategory: "unhealthy_http_response",
        httpStatusCode: 503
      });
      expect(failedMetric.latencyMs).toEqual(expect.any(Number));
      expect(await Service.findById("user-service").lean()).toMatchObject({
        probeStatus: "degraded",
        probeFailureCount: sampleConfig.failureThreshold
      });
      expect(await Incident.countDocuments({
        serviceId: "user-service",
        source: "http_probe",
        status: "open"
      })).toBe(1);

      statusCode = 200;
      await collector.collectOnce();
      expect(await Service.findById("user-service").lean()).toMatchObject({
        probeStatus: "degraded",
        probeSuccessCount: 1
      });
      expect(await Incident.countDocuments({
        serviceId: "user-service",
        source: "http_probe",
        status: "open"
      })).toBe(1);

      await collector.collectOnce();
      expect(await Service.findById("user-service").lean()).toMatchObject({
        probeStatus: "healthy",
        probeFailureCount: 0
      });
      expect(await Incident.countDocuments({
        serviceId: "user-service",
        source: "http_probe",
        status: "open"
      })).toBe(0);
      expect(await Incident.countDocuments({
        serviceId: "user-service",
        source: "http_probe",
        status: "resolved"
      })).toBe(1);

      await collector.stop();
    });
  });

  it("reports connection errors and timeouts without inventing latency", async () => {
    let closedEndpoint;
    await withLocalHttpServer((_req, res) => res.end("ok"), async ({ endpoint, server }) => {
      const address = server.address();
      closedEndpoint = {
        ...endpoint,
        url: `http://127.0.0.1:${address.port + 1}/health`
      };
    });
    const connectionFailure = await probeHttpEndpoint({
      endpoint: closedEndpoint,
      timeoutMs: 500,
      allowLocalHttp: true
    });
    expect(connectionFailure).toMatchObject({
      outcome: "connection_error",
      failureCategory: "connection_error",
      latencyMs: null,
      httpStatusCode: null
    });

    await withLocalHttpServer(() => {}, async ({ endpoint }) => {
      const timedOut = await probeHttpEndpoint({
        endpoint,
        timeoutMs: 50,
        allowLocalHttp: true
      });
      expect(timedOut).toMatchObject({
        outcome: "timeout",
        failureCategory: "timeout",
        latencyMs: null,
        httpStatusCode: null
      });
    });
  });

  it("persists unconfigured and failed HTTP probe samples with correct source", async () => {
    const saved = [];
    const emitted = [];
    const collector = createHttpProbeCollector({
      config: sampleConfig,
      endpoints: new Map(),
      serviceModel: {
        find: () => ({
          select: () => ({
            lean: async () => [{ _id: "user-service" }]
          })
        }),
        updateMany: vi.fn().mockResolvedValue({})
      },
      metricModel: {
        create: async (metric) => {
          saved.push(metric);
          return metric;
        }
      },
      applyResult: vi.fn(),
      emit: (...event) => emitted.push(event),
      log: { error: vi.fn() }
    });
    await collector.collectOnce();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      serviceId: "user-service",
      source: "http_probe",
      status: "unconfigured",
      outcome: "unconfigured",
      latencyMs: null
    });
    expect(emitted[0][0]).toBe(REALTIME_EVENTS.METRICS_SAMPLE);
  });

  it("does not overlap scheduled probe cycles and stops cleanly", async () => {
    let releaseProbe;
    let probeCalls = 0;
    const pendingProbe = new Promise((resolve) => {
      releaseProbe = resolve;
    });
    const metricModel = { create: vi.fn(async (sample) => sample) };
    const serviceModel = {
      find: () => ({
        select: () => ({
          lean: async () => [{ _id: "user-service" }]
        })
      }),
      updateMany: vi.fn().mockResolvedValue({})
    };
    const collector = createHttpProbeCollector({
      config: sampleConfig,
      endpoints: new Map([
        ["user-service", { url: "https://health.example/status" }]
      ]),
      serviceModel,
      metricModel,
      probe: async () => {
        probeCalls += 1;
        return pendingProbe;
      },
      applyResult: vi.fn(),
      emit: vi.fn(),
      log: { error: vi.fn() }
    });

    const firstCycle = collector.collectOnce();
    const overlappingCycle = collector.collectOnce();
    expect(overlappingCycle).toBe(firstCycle);
    await vi.waitFor(() => expect(probeCalls).toBe(1));
    releaseProbe({
      outcome: "success",
      latencyMs: 10,
      httpStatusCode: 200,
      failureCategory: null,
      measuredAt: new Date()
    });
    await firstCycle;

    expect(await collector.start()).toBe(true);
    expect(await collector.start()).toBe(false);
    await collector.stop();
    expect(serviceModel.updateMany).toHaveBeenCalledTimes(1);
    expect(serviceModel.updateMany.mock.calls[0][2]).toEqual({
      updatePipeline: true
    });
    await expect(collector.start()).rejects.toThrow(
      "A stopped HTTP probe collector cannot restart."
    );
  });

  it("creates one monitoring incident at the failure threshold and resolves it after recovery", async () => {
    const failure = {
      outcome: "connection_error",
      failureCategory: "connection_error",
      latencyMs: null,
      httpStatusCode: null,
      measuredAt: new Date()
    };
    for (let attempt = 0; attempt < sampleConfig.failureThreshold; attempt += 1) {
      await applyProbeResult("user-service", failure, sampleConfig);
    }
    expect(await Service.findById("user-service").lean()).toMatchObject({
      probeStatus: "degraded",
      probeFailureCount: sampleConfig.failureThreshold
    });
    expect(await Incident.countDocuments({
      serviceId: "user-service",
      source: "http_probe",
      status: "open"
    })).toBe(1);

    for (let attempt = 0; attempt < sampleConfig.recoveryThreshold; attempt += 1) {
      await applyProbeResult("user-service", {
        outcome: "success",
        failureCategory: null,
        latencyMs: 12,
        httpStatusCode: 200,
        measuredAt: new Date()
      }, sampleConfig);
    }
    expect(await Service.findById("user-service").lean()).toMatchObject({
      probeStatus: "healthy",
      probeFailureCount: 0
    });
    expect(await Incident.countDocuments({
      serviceId: "user-service",
      source: "http_probe",
      status: "open"
    })).toBe(0);
  });

  it("does not let probe results alter service state owned by an experiment", async () => {
    const experiment = await request(app)
      .post("/api/experiments")
      .send({ serviceId: "user-service", durationSeconds: 30 })
      .expect(201);
    for (let attempt = 0; attempt < sampleConfig.failureThreshold; attempt += 1) {
      await applyProbeResult("user-service", {
        outcome: "connection_error",
        failureCategory: "connection_error",
        latencyMs: null,
        httpStatusCode: null,
        measuredAt: new Date()
      }, sampleConfig);
    }
    expect(await Service.findById("user-service").lean()).toMatchObject({
      status: "degraded",
      activeExperimentId: experiment.body.data.id,
      probeStatus: "unconfigured"
    });
    expect(await Incident.countDocuments({
      serviceId: "user-service",
      source: "http_probe"
    })).toBe(0);
    await request(app)
      .post(`/api/experiments/${experiment.body.data.id}/cancel`)
      .expect(200);
  });

  it("samples every persisted service state as a simulated metric", async () => {
    await request(app).post("/api/services/payment-service/failure").expect(200);
    const measuredAt = new Date("2099-10-13T10:00:00.000Z");
    const emit = vi.fn();
    const collector = createMetricsCollector({
      config: sampleConfig,
      emit,
      clock: () => measuredAt
    });

    const result = await collector.collectOnce();
    const storedMetrics = await Metric.find().lean();
    const paymentMetric = storedMetrics.find(
      (metric) => metric.serviceId === "payment-service"
    );

    expect(result).toEqual({ persisted: 3, failed: 0 });
    expect(storedMetrics.map((metric) => metric.serviceId).sort()).toEqual([
      "order-service",
      "payment-service",
      "user-service"
    ]);
    expect(paymentMetric).toMatchObject({
      latencyMs: 5000,
      status: "degraded",
      source: "simulated",
      samplingIntervalMs: sampleConfig.samplingIntervalMs,
      measuredAt,
      expiresAt: new Date(measuredAt.getTime() + sampleConfig.retentionMs)
    });
    expect(emit).toHaveBeenCalledTimes(3);
    expect(emit).toHaveBeenCalledWith(
      REALTIME_EVENTS.METRICS_SAMPLE,
      expect.objectContaining({
        eventId: paymentMetric._id,
        timestamp: measuredAt.toISOString(),
        serviceId: "payment-service",
        latencyMs: 5000,
        status: "degraded",
        source: "simulated"
      })
    );
  });

  it("filters metrics by service and inclusive ISO timestamp range", async () => {
    const start = new Date("2099-09-01T12:00:00.000Z");
    await Metric.create([
      createMetricFixture({
        _id: "metric-user-old",
        measuredAt: new Date(start.getTime() - 1000)
      }),
      createMetricFixture({
        _id: "metric-user-in-range",
        measuredAt: start
      }),
      createMetricFixture({
        _id: "metric-user-later",
        measuredAt: new Date(start.getTime() + 2000)
      }),
      createMetricFixture({
        _id: "metric-order-in-range",
        serviceId: "order-service",
        measuredAt: start
      })
    ]);

    const response = await request(app)
      .get("/api/metrics")
      .query({
        serviceId: "user-service",
        from: start.toISOString(),
        to: new Date(start.getTime() + 1000).toISOString()
      })
      .expect(200);

    expect(response.body).toMatchObject({ success: true, count: 1, total: 1 });
    expect(response.body.data[0]).toMatchObject({
      id: "metric-user-in-range",
      serviceId: "user-service",
      timestamp: start.toISOString(),
      source: "simulated"
    });
  });

  it("rejects invalid, reversed, and non-ISO metric time ranges", async () => {
    for (const query of [
      { from: "not-a-date" },
      { from: "2026-10-13" },
      { from: "2026-02-30T10:00:00.000Z" },
      {
        from: "2026-10-14T00:00:00.000Z",
        to: "2026-10-13T00:00:00.000Z"
      }
    ]) {
      const response = await request(app)
        .get("/api/metrics")
        .query(query)
        .expect(400);
      expect(response.body.success).toBe(false);
    }
  });

  it("enforces the maximum metrics query limit", async () => {
    const response = await request(app)
      .get("/api/metrics")
      .query({ limit: 501 })
      .expect(400);

    expect(response.body).toEqual({
      success: false,
      message: "Limit must be between 1 and 500"
    });
  });

  it("filters metric history by source and serializes nullable latency", async () => {
    await Metric.create([
      createMetricFixture({ _id: "history-simulated" }),
      createMetricFixture({
        _id: "history-probe-timeout",
        source: "http_probe",
        latencyMs: null,
        status: "degraded",
        outcome: "timeout",
        failureCategory: "timeout"
      })
    ]);

    const response = await request(app)
      .get("/api/metrics")
      .query({ serviceId: "user-service", source: "http_probe" })
      .expect(200);
    expect(response.body).toMatchObject({
      count: 1,
      total: 1,
      data: [
        {
          id: "history-probe-timeout",
          latencyMs: null,
          source: "http_probe",
          outcome: "timeout",
          failureCategory: "timeout"
        }
      ]
    });
  });

  it("calculates metric summaries from persisted records by source", async () => {
    await Metric.create([
      createMetricFixture({
        _id: "summary-healthy-one",
        latencyMs: 20
      }),
      createMetricFixture({
        _id: "summary-healthy-two",
        latencyMs: 40,
        source: "http_probe"
      }),
      createMetricFixture({
        _id: "summary-degraded",
        latencyMs: 60,
        status: "degraded"
      })
    ]);

    const response = await request(app)
      .get("/api/metrics/summary")
      .query({ serviceId: "user-service", source: "simulated" })
      .expect(200);

    expect(response.body).toEqual({
      success: true,
      data: {
        count: 2,
        measurementCount: 2,
        averageLatencyMs: 40,
        minimumLatencyMs: 20,
        maximumLatencyMs: 60,
        byStatus: { degraded: 1, healthy: 1 },
        bySource: { simulated: 2 }
      }
    });
  });

  it("excludes null-latency probe samples from summary statistics", async () => {
    await Metric.create([
      createMetricFixture({
        _id: "probe-with-latency",
        source: "http_probe",
        latencyMs: 30,
        httpStatusCode: 200,
        outcome: "success"
      }),
      createMetricFixture({
        _id: "probe-timeout",
        source: "http_probe",
        latencyMs: null,
        status: "degraded",
        outcome: "timeout",
        failureCategory: "timeout",
        httpStatusCode: null
      })
    ]);

    const response = await request(app)
      .get("/api/metrics/summary")
      .query({ serviceId: "user-service", source: "http_probe" })
      .expect(200);

    expect(response.body.data).toMatchObject({
      count: 2,
      measurementCount: 1,
      averageLatencyMs: 30,
      minimumLatencyMs: 30,
      maximumLatencyMs: 30,
      byStatus: { degraded: 1, healthy: 1 },
      bySource: { http_probe: 2 }
    });
  });

  it("uses a MongoDB TTL index and expires samples according to retention", async () => {
    const measuredAt = new Date("2099-10-13T10:00:00.000Z");
    const collector = createMetricsCollector({
      config: { ...sampleConfig, retentionMs: 24 * 60 * 60 * 1000 },
      clock: () => measuredAt,
      emit: () => {}
    });
    await collector.collectOnce();

    const ttlIndex = Metric.schema.indexes().find(
      ([keys, options]) => keys.expiresAt === 1 && options.expireAfterSeconds === 0
    );
    expect(ttlIndex).toBeDefined();
    const metric = await Metric.findOne({ serviceId: "user-service" }).lean();
    expect(metric.expiresAt).toEqual(
      new Date(measuredAt.getTime() + 24 * 60 * 60 * 1000)
    );
  });

  it("prevents overlapping samples and awaits an active cycle during stop", async () => {
    let resolveQuery;
    let queryCount = 0;
    const serviceModel = {
      find() {
        queryCount += 1;
        return {
          select() {
            return this;
          },
          lean() {
            return new Promise((resolve) => {
              resolveQuery = resolve;
            });
          }
        };
      }
    };
    const collector = createMetricsCollector({
      config: sampleConfig,
      serviceModel,
      metricModel: { create: vi.fn() },
      emit: () => {}
    });

    const firstCycle = collector.collectOnce();
    const overlappingCycle = collector.collectOnce();
    expect(overlappingCycle).toBe(firstCycle);
    expect(queryCount).toBe(1);

    const stopping = collector.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    resolveQuery([]);
    await Promise.all([firstCycle, stopping]);
    expect(stopped).toBe(true);
    expect(queryCount).toBe(1);

    const idleCollector = createMetricsCollector({
      config: sampleConfig,
      serviceModel: {
        find: () => ({
          select() {
            return this;
          },
          lean: async () => []
        })
      },
      emit: () => {}
    });
    expect(idleCollector.start()).toBe(true);
    expect(idleCollector.start()).toBe(false);
    await idleCollector.stop();
  });

  it("does not create duplicate singleton sampling timers", async () => {
    const first = startMetricsCollection(sampleConfig);
    const second = startMetricsCollection(sampleConfig);
    expect(second).toBe(first);
    await stopMetricsCollection();
  });

  it("does not start collection when metrics are disabled", () => {
    expect(
      startMetricsCollection({ ...sampleConfig, enabled: false })
    ).toBeUndefined();
  });

  it("logs database sampling failures and continues without emitting unpersisted samples", async () => {
    const log = { error: vi.fn() };
    const emit = vi.fn();
    const queryFailureCollector = createMetricsCollector({
      config: sampleConfig,
      serviceModel: { find: () => { throw new Error("database unavailable"); } },
      log,
      emit
    });
    expect(await queryFailureCollector.collectOnce()).toEqual({
      persisted: 0,
      failed: 1
    });
    expect(log.error).toHaveBeenCalledWith(
      "metrics.sampling_query_failed",
      expect.objectContaining({ errorName: "Error" })
    );
    expect(emit).not.toHaveBeenCalled();

    const failingMetricCollector = createMetricsCollector({
      config: sampleConfig,
      serviceModel: {
        find: () => ({
          select() {
            return this;
          },
          lean: async () => [
            { _id: "user-service", status: "healthy", latency: 45 },
            { _id: "order-service", status: "healthy", latency: 80 }
          ]
        })
      },
      metricModel: {
        create: async (metric) => {
          if (metric.serviceId === "user-service") {
            throw new Error("write unavailable");
          }
          return metric;
        }
      },
      log,
      emit
    });
    expect(await failingMetricCollector.collectOnce()).toEqual({
      persisted: 1,
      failed: 1
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      "metrics.sample_persist_failed",
      expect.objectContaining({ serviceId: "user-service" })
    );
  });

  it("imports the Express app without connecting to MongoDB or opening a listener", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import mongoose from 'mongoose'; await import('./src/app.js'); if (mongoose.connection.readyState !== 0) process.exit(1); console.log('APP_IMPORTED_WITHOUT_CONNECTION');"
      ],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        encoding: "utf8"
      }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("APP_IMPORTED_WITHOUT_CONNECTION");
  });

  it("returns the default services in the expected order", async () => {
    const response = await request(app).get("/api/services").expect(200);
    const expectedServices = [
      { id: "user-service", name: "User Service", status: "healthy", latency: 45 },
      { id: "order-service", name: "Order Service", status: "healthy", latency: 80 },
      { id: "payment-service", name: "Payment Service", status: "healthy", latency: 100 }
    ];

    expect(response.body.success).toBe(true);
    expect(response.body.count).toBe(3);
    expect(response.body.data).toEqual(
      expectedServices.map((service) => ({
        ...service,
        probeConfigured: false,
        probeStatus: "unconfigured",
        lastProbeAt: null,
        lastProbeOutcome: "unconfigured",
        lastProbeLatencyMs: null,
        lastProbeHttpStatus: null
      }))
    );
  });

  it("persists a critical incident when failure is injected", async () => {
    const response = await request(app)
      .post("/api/services/payment-service/failure")
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data).toMatchObject({
      id: "payment-service",
      status: "degraded",
      latency: 5000
    });
    expect(response.body.incident).toMatchObject({
      serviceId: "payment-service",
      severity: "critical",
      status: "open",
      resolvedAt: null
    });

    const [service, incident] = await Promise.all([
      Service.findById("payment-service").lean(),
      Incident.findById(response.body.incident.id).lean()
    ]);
    expect(service).toMatchObject({ status: "degraded", latency: 5000 });
    expect(incident).toMatchObject({
      serviceId: "payment-service",
      severity: "critical",
      status: "open",
      resolvedAt: null
    });
  });

  it("does not create a second open incident on repeated failure", async () => {
    await request(app).post("/api/services/payment-service/failure").expect(200);
    const repeatedResponse = await request(app)
      .post("/api/services/payment-service/failure")
      .expect(200);

    expect(repeatedResponse.body).toMatchObject({
      success: true,
      message: "Payment Service is already degraded",
      data: {
        id: "payment-service",
        status: "degraded",
        latency: 5000
      }
    });
    expect(repeatedResponse.body).not.toHaveProperty("incident");
    expect(
      await Incident.countDocuments({
        serviceId: "payment-service",
        status: "open"
      })
    ).toBe(1);
    expect(await Service.findById("payment-service").lean()).toMatchObject({
      status: "degraded",
      latency: 5000
    });
  });

  it("recovers a service and persists its resolved incident", async () => {
    const failure = await request(app)
      .post("/api/services/payment-service/failure")
      .expect(200);
    const recovery = await request(app)
      .post("/api/services/payment-service/recover")
      .expect(200);

    expect(recovery.body.success).toBe(true);
    expect(recovery.body.data).toMatchObject({
      id: "payment-service",
      status: "healthy",
      latency: 100
    });
    expect(recovery.body.incident).toMatchObject({
      id: failure.body.incident.id,
      status: "resolved"
    });
    expect(Number.isNaN(Date.parse(recovery.body.incident.resolvedAt))).toBe(
      false
    );
    expect(
      await Incident.countDocuments({ serviceId: "payment-service" })
    ).toBe(1);

    const [service, incident] = await Promise.all([
      Service.findById("payment-service").lean(),
      Incident.findById(failure.body.incident.id).lean()
    ]);
    expect(service).toMatchObject({ status: "healthy", latency: 100 });
    expect(incident.status).toBe("resolved");
    expect(incident.resolvedAt).toBeInstanceOf(Date);
  });

  it("returns 404 for unknown services on failure and recovery", async () => {
    for (const action of ["failure", "recover"]) {
      const response = await request(app)
        .post(`/api/services/nonexistent-service/${action}`)
        .expect(404);

      expect(response.body).toEqual({
        success: false,
        message: "Service not found"
      });
    }
  });

  it("returns a consistent client error for malformed JSON", async () => {
    const response = await request(app)
      .post("/api/services/payment-service/failure")
      .set("Content-Type", "application/json")
      .send('{"unexpected":')
      .expect(400);

    expect(response.body).toEqual({
      success: false,
      message: "Malformed JSON request body"
    });
  });

  it("rejects request bodies because simulator actions accept no payload", async () => {
    const response = await request(app)
      .post("/api/services/payment-service/failure")
      .send({ status: "healthy", latency: 1 })
      .expect(400);

    expect(response.body).toEqual({
      success: false,
      message: "Request body is not supported"
    });
    expect(await Service.findById("payment-service").lean()).toMatchObject({
      status: "healthy",
      latency: 100
    });
    expect(await Incident.countDocuments({})).toBe(0);
  });

  it("rejects JSON payloads larger than the configured request limit", async () => {
    const response = await request(app)
      .post("/api/services/payment-service/failure")
      .send({ payload: "x".repeat(17 * 1024) })
      .expect(413);

    expect(response.body).toEqual({
      success: false,
      message: "Request body too large"
    });
  });

  it("returns a client error for a malformed service ID", async () => {
    const response = await request(app)
      .post("/api/services/invalid_service/failure")
      .expect(400);

    expect(response.body).toEqual({
      success: false,
      message: "Invalid service ID"
    });
  });

  it("does not expose unexpected route errors in JSON responses", async () => {
    const findSpy = vi
      .spyOn(Service, "find")
      .mockImplementation(() => ({
        lean: () =>
          Promise.reject(
            new Error("database credentials must not be returned")
          )
      }));
    const loggerSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

    try {
      const response = await request(app).get("/api/services").expect(500);

      expect(response.body).toEqual({
        success: false,
        message: "An unexpected server error occurred"
      });
      expect(JSON.stringify(response.body)).not.toContain("credentials");
      expect(loggerSpy).toHaveBeenCalledWith(
        "http.request_failed",
        expect.objectContaining({
          method: "GET",
          path: "/api/services",
          errorName: "Error"
        })
      );
    } finally {
      findSpy.mockRestore();
      loggerSpy.mockRestore();
    }
  });

  it("compensates the service state when incident creation fails", async () => {
    const saveSpy = vi
      .spyOn(Incident.prototype, "save")
      .mockRejectedValue(new Error("simulated database write failure"));
    const loggerSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

    try {
      const response = await request(app)
        .post("/api/services/payment-service/failure")
        .expect(500);

      expect(response.body).toEqual({
        success: false,
        message: "An unexpected server error occurred"
      });
      expect(await Service.findById("payment-service").lean()).toMatchObject({
        status: "healthy",
        latency: 100
      });
      expect(await Incident.countDocuments({})).toBe(0);
    } finally {
      saveSpy.mockRestore();
      loggerSpy.mockRestore();
    }
  });

  it("compensates the service state when incident resolution fails", async () => {
    await request(app).post("/api/services/payment-service/failure").expect(200);
    const updateSpy = vi
      .spyOn(Incident, "findOneAndUpdate")
      .mockRejectedValue(new Error("simulated database write failure"));
    const loggerSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

    try {
      const response = await request(app)
        .post("/api/services/payment-service/recover")
        .expect(500);

      expect(response.body).toEqual({
        success: false,
        message: "An unexpected server error occurred"
      });
      expect(await Service.findById("payment-service").lean()).toMatchObject({
        status: "degraded",
        latency: 5000
      });
      expect(
        await Incident.countDocuments({
          serviceId: "payment-service",
          status: "open"
        })
      ).toBe(1);
    } finally {
      updateSpy.mockRestore();
      loggerSpy.mockRestore();
    }
  });

  it("lists serialized incidents newest first", async () => {
    const older = new Date("2026-01-01T10:00:00.000Z");
    const newer = new Date("2026-01-02T10:00:00.000Z");
    await Incident.create([
      {
        _id: "older-incident",
        serviceId: "user-service",
        serviceName: "User Service",
        title: "Older incident",
        description: "Earlier test incident",
        severity: "warning",
        status: "resolved",
        createdAt: older,
        resolvedAt: new Date("2026-01-01T10:30:00.000Z")
      },
      {
        _id: "newer-incident",
        serviceId: "payment-service",
        serviceName: "Payment Service",
        title: "Newer incident",
        description: "Later test incident",
        source: "simulator",
        severity: "critical",
        status: "open",
        createdAt: newer,
        resolvedAt: null
      }
    ]);

    const response = await request(app).get("/api/incidents").expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.count).toBe(2);
    expect(response.body.data.map((incident) => incident.id)).toEqual([
      "newer-incident",
      "older-incident"
    ]);
    expect(response.body.data[0]).toEqual({
      id: "newer-incident",
      serviceId: "payment-service",
      serviceName: "Payment Service",
      title: "Newer incident",
      description: "Later test incident",
      source: "simulator",
      severity: "critical",
      status: "open",
      createdAt: newer.toISOString(),
      resolvedAt: null
    });
    expect(response.body.data[1].createdAt).toBe(older.toISOString());
    expect(response.body.data[1].resolvedAt).toBe(
      "2026-01-01T10:30:00.000Z"
    );
  });

  it("retains persisted records after disconnecting and reconnecting", async () => {
    const failure = await request(app)
      .post("/api/services/payment-service/failure")
      .expect(200);

    assertSafeTestConnection();
    await mongoose.disconnect();
    await initializeDatabase(testUri);
    assertSafeTestConnection();

    const [service, incident] = await Promise.all([
      Service.findById("payment-service").lean(),
      Incident.findById(failure.body.incident.id).lean()
    ]);
    expect(service).toMatchObject({ status: "degraded", latency: 5000 });
    expect(incident).toMatchObject({
      serviceId: "payment-service",
      status: "open"
    });
  });

  it("keeps one open incident for simultaneous failure requests", async () => {
    const responses = await Promise.all([
      request(app).post("/api/services/payment-service/failure"),
      request(app).post("/api/services/payment-service/failure")
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(
      await Incident.countDocuments({
        serviceId: "payment-service",
        status: "open"
      })
    ).toBe(1);
    expect(await Service.findById("payment-service").lean()).toMatchObject({
      status: "degraded",
      latency: 5000
    });
  });

  it("keeps recovery idempotent for simultaneous requests", async () => {
    await request(app).post("/api/services/payment-service/failure").expect(200);
    const responses = await Promise.all([
      request(app).post("/api/services/payment-service/recover"),
      request(app).post("/api/services/payment-service/recover")
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await Service.findById("payment-service").lean()).toMatchObject({
      status: "healthy",
      latency: 100
    });
    expect(
      await Incident.countDocuments({
        serviceId: "payment-service",
        status: "open"
      })
    ).toBe(0);
    expect(await Incident.countDocuments({ serviceId: "payment-service" })).toBe(
      1
    );
  });

  it("leaves a valid service and incident state when failure races recovery", async () => {
    const responses = await Promise.all([
      request(app).post("/api/services/payment-service/failure"),
      request(app).post("/api/services/payment-service/recover")
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);

    const service = await Service.findById("payment-service").lean();
    const incidents = await Incident.find({
      serviceId: "payment-service"
    }).lean();

    if (service.status === "degraded") {
      expect(service.latency).toBe(5000);
      expect(incidents).toHaveLength(1);
      expect(incidents[0].status).toBe("open");
    } else {
      expect(service).toMatchObject({ status: "healthy", latency: 100 });
      expect(incidents).toHaveLength(1);
      expect(incidents[0].status).toBe("resolved");
      expect(incidents[0].resolvedAt).toBeInstanceOf(Date);
    }
  });

  it("connects over Socket.IO and emits persisted service and incident events", async () => {
    const runningServer = await startServer({
      port: 0,
      mongodbUri: testUri
    });
    const address = runningServer.server.address();
    const socket = createSocketClient(
      `http://127.0.0.1:${address.port}`,
      {
        transports: ["websocket"],
        reconnection: false,
        extraHeaders: { Origin: "http://localhost:5173" }
      }
    );

    const waitForEvent = (eventName) =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          socket.off(eventName, onEvent);
          reject(new Error(`Timed out waiting for ${eventName}`));
        }, 5000);
        timeout.unref();
        const onEvent = (payload) => {
          clearTimeout(timeout);
          resolve(payload);
        };
        socket.once(eventName, onEvent);
      });

    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          socket.disconnect();
          reject(new Error("Socket.IO connection timed out"));
        }, 5000);
        timeout.unref();
        socket.once("connect", () => {
          clearTimeout(timeout);
          resolve();
        });
        socket.once("connect_error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      const probeUpdateEvent = waitForEvent(REALTIME_EVENTS.SERVICE_PROBE_UPDATED);
      await applyProbeResult(
        "user-service",
        {
          outcome: "success",
          failureCategory: null,
          latencyMs: 18,
          httpStatusCode: 200,
          measuredAt: new Date()
        },
        sampleConfig
      );
      expect(await probeUpdateEvent).toMatchObject({
        serviceId: "user-service",
        status: "healthy",
        outcome: "success",
        httpStatusCode: 200
      });

      const createdEvent = waitForEvent("incident:created");
      const failureEvent = waitForEvent("service:failure");
      const failureResponse = await request(app)
        .post("/api/services/payment-service/failure")
        .expect(200);
      const [created, failed] = await Promise.all([
        createdEvent,
        failureEvent
      ]);

      expect(created).toMatchObject({
        service: {
          id: "payment-service",
          status: "degraded",
          latency: 5000
        },
        incident: {
          id: failureResponse.body.incident.id,
          serviceId: "payment-service",
          status: "open",
          resolvedAt: null
        }
      });
      expect(created.eventId).toEqual(expect.any(String));
      expect(Number.isNaN(Date.parse(created.occurredAt))).toBe(false);
      expect(failed.incident.id).toBe(created.incident.id);
      expect(
        await Incident.findById(created.incident.id).lean()
      ).toMatchObject({ status: "open" });

      const resolvedEvent = waitForEvent("incident:resolved");
      const recoveredEvent = waitForEvent("service:recovered");
      const recoveryResponse = await request(app)
        .post("/api/services/payment-service/recover")
        .expect(200);
      const [resolved, recovered] = await Promise.all([
        resolvedEvent,
        recoveredEvent
      ]);

      expect(resolved).toMatchObject({
        service: {
          id: "payment-service",
          status: "healthy",
          latency: 100
        },
        incident: {
          id: created.incident.id,
          status: "resolved"
        }
      });
      expect(recovered.incident.id).toBe(resolved.incident.id);
      expect(recoveryResponse.body.incident.id).toBe(resolved.incident.id);
      expect(
        await Incident.findById(resolved.incident.id).lean()
      ).toMatchObject({ status: "resolved" });

      const metricsEvent = waitForEvent(REALTIME_EVENTS.METRICS_SAMPLE);
      const collector = createMetricsCollector({
        config: sampleConfig,
        emit: (eventName, payload) => runningServer.io.emit(eventName, payload)
      });
      await collector.collectOnce();
      const sample = await metricsEvent;
      const storedSample = await Metric.findById(sample.eventId).lean();
      expect(sample).toMatchObject({
        eventId: expect.any(String),
        timestamp: expect.any(String),
        serviceId: expect.any(String),
        latencyMs: expect.any(Number),
        status: expect.any(String),
        source: "simulated"
      });
      expect(storedSample).toMatchObject({
        serviceId: sample.serviceId,
        latencyMs: sample.latencyMs,
        status: sample.status,
        source: "simulated"
      });

      const experimentEvent = new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out waiting for experiment update")),
          5000
        );
        timeout.unref();
        socket.once(REALTIME_EVENTS.EXPERIMENT_UPDATED, (payload) => {
          clearTimeout(timeout);
          resolve(payload);
        });
      });
      const createdExperiment = await request(app)
        .post("/api/experiments")
        .send({ serviceId: "user-service", durationSeconds: 60 })
        .expect(201);
      const experimentUpdate = await experimentEvent;
      expect(experimentUpdate.experiment).toMatchObject({
        id: createdExperiment.body.data.id,
        serviceId: "user-service",
        status: "pending"
      });
      expect(
        await Experiment.findById(createdExperiment.body.data.id).lean()
      ).toMatchObject({ status: "running" });

      const rejectedSocket = createSocketClient(
        `http://127.0.0.1:${address.port}`,
        {
          transports: ["websocket"],
          reconnection: false,
          extraHeaders: { Origin: "https://untrusted.example" }
        }
      );
      try {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            rejectedSocket.disconnect();
            reject(new Error("Disallowed Socket.IO origin was not rejected"));
          }, 5000);
          timeout.unref();
          rejectedSocket.once("connect_error", () => {
            clearTimeout(timeout);
            resolve();
          });
          rejectedSocket.once("connect", () => {
            clearTimeout(timeout);
            reject(new Error("Disallowed Socket.IO origin connected"));
          });
        });
        expect(rejectedSocket.connected).toBe(false);
      } finally {
        rejectedSocket.disconnect();
      }
    } finally {
      socket.disconnect();
      await runningServer.shutdown();
    }
  });

  it("fails startup clearly when MongoDB is unavailable", async () => {
    const serverPath = fileURLToPath(
      new URL("../src/server.js", import.meta.url)
    );
    const child = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        PORT: "0",
        MONGODB_URI:
          "mongodb://127.0.0.1:1/pulseops_test?serverSelectionTimeoutMS=300"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });

    const closeResult = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("Startup failure child process did not exit"));
      }, 10000);
      child.once("close", (...result) => {
        clearTimeout(timeout);
        resolve(result);
      });
    });

    expect(closeResult[0]).toBe(1);
    expect(output).toContain('"event":"server.startup_failed"');
    expect(output).not.toContain("mongodb://");
  });

  it("closes its HTTP listener and MongoDB connection during graceful shutdown", async () => {
    const runningServer = await startServer({
      port: 0,
      host: "127.0.0.1",
      mongodbUri: testUri,
      shutdownTimeoutMs: 1000
    });

    const experimentResponse = await request(app)
      .post("/api/experiments")
      .send({ serviceId: "payment-service", durationSeconds: 60 })
      .expect(201);
    const health = await request(runningServer.server)
      .get("/api/health")
      .expect(200);
    expect(health.body.success).toBe(true);
    expect(runningServer.server.address().address).toBe("127.0.0.1");

    await Promise.all([
      runningServer.shutdown(),
      runningServer.shutdown()
    ]);
    expect(runningServer.server.listening).toBe(false);
    await initializeDatabase(testUri);
    expect(await Experiment.findById(experimentResponse.body.data.id).lean()).toMatchObject({
      status: "failed",
      outcome: "Experiment was safely stopped during server shutdown."
    });
    expect(await Service.findById("payment-service").lean()).toMatchObject({
      status: "healthy",
      activeExperimentId: null
    });
    await mongoose.disconnect();
    expect(mongoose.connection.readyState).toBe(0);
  });
});
