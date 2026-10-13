import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import Incident from "./models/Incident.js";
import Experiment from "./models/Experiment.js";
import Service from "./models/Service.js";
import {
  DEFAULT_SERVICES,
  SERVICE_ORDER
} from "./config/services.js";
import HttpError from "./utils/HttpError.js";
import { logger } from "./utils/logger.js";
import { getAllowedDashboardOrigins } from "./config/origins.js";
import metricsRouter from "./routes/metrics.js";
import experimentsRouter from "./routes/experiments.js";
import {
  recoverService,
  serializeIncident,
  serializeService,
  simulateServiceFailure
} from "./services/serviceOperations.js";

dotenv.config();

const app = express();
const supportedServiceIds = new Set(
  DEFAULT_SERVICES.map((service) => service.id)
);
const allowedOrigins = new Set(getAllowedDashboardOrigins());

app.use((req, res, next) => {
  req.requestId = randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
});

app.use(cors({
  origin(origin, callback) {
    callback(null, !origin || allowedOrigins.has(origin));
  }
}));
app.use(express.json({ limit: "16kb", strict: true }));

function validateServiceId(serviceId) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(serviceId)) {
    throw new HttpError(400, "Invalid service ID");
  }
  if (!supportedServiceIds.has(serviceId)) {
    throw new HttpError(404, "Service not found");
  }
}

function rejectUnsupportedBody(req, res, next) {
  const contentLength = Number(req.get("content-length") || 0);
  if (
    req.body !== undefined ||
    contentLength > 0 ||
    req.get("transfer-encoding")
  ) {
    return next(new HttpError(400, "Request body is not supported"));
  }
  return next();
}

function serializeError(error, req, res, next) {
  if (res.headersSent) return next(error);

  let status = 500;
  let message = "An unexpected server error occurred";

  if (error instanceof HttpError) {
    status = error.status;
    message = error.message;
  } else if (error.type === "entity.parse.failed") {
    status = 400;
    message = "Malformed JSON request body";
  } else if (error.type === "entity.too.large") {
    status = 413;
    message = "Request body too large";
  } else if (error instanceof URIError && error.status === 400) {
    status = 400;
    message = "Invalid URL path";
  } else {
    logger.error("http.request_failed", {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      errorName: error.name || "Error",
      errorCode:
        typeof error.code === "string" || typeof error.code === "number"
          ? error.code
          : undefined
    });
  }

  if (status < 500) {
    logger.warn("http.request_rejected", {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      status
    });
  }

  return res.status(status).json({
    success: false,
    message
  });
}

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "PulseOps API is running"
  });
});

app.get("/api/services", async (req, res) => {
  const services = await Service.find().lean();
  services.sort(
    (left, right) =>
      (SERVICE_ORDER.get(left._id) ?? Infinity) -
      (SERVICE_ORDER.get(right._id) ?? Infinity)
  );

  res.json({
    success: true,
    count: services.length,
    data: services.map(serializeService)
  });
});

app.get("/api/incidents", async (req, res) => {
  const incidents = await Incident.find().sort({ createdAt: -1 }).lean();

  res.json({
    success: true,
    count: incidents.length,
    data: incidents.map(serializeIncident)
  });
});

app.use("/api/metrics", metricsRouter);
app.use("/api/experiments", experimentsRouter);

app.post(
  "/api/services/:id/failure",
  rejectUnsupportedBody,
  async (req, res) => {
    validateServiceId(req.params.id);

    const result = await simulateServiceFailure(req.params.id, {
      requestId: req.requestId
    });
    if (result.alreadyDegraded) {
      return res.json({
        success: true,
        message: `${result.service.name} is already degraded`,
        data: serializeService(result.service)
      });
    }
    return res.json({
      success: true,
      message: `${result.service.name} failure simulated. Incident created.`,
      data: serializeService(result.service),
      incident: serializeIncident(result.incident)
    });
  }
);

app.post(
  "/api/services/:id/recover",
  rejectUnsupportedBody,
  async (req, res) => {
    validateServiceId(req.params.id);

    const service = await Service.findById(req.params.id).lean();
    if (!service) throw new HttpError(404, "Service not found");
    if (service.activeExperimentId) {
      const activeExperiment = await Experiment.exists({
        _id: service.activeExperimentId,
        status: { $in: ["pending", "running"] }
      });
      if (activeExperiment) {
        throw new HttpError(409, "Service is owned by an active experiment");
      }
    }

    const result = await recoverService(req.params.id, {
      experimentId: service.activeExperimentId || null,
      requestId: req.requestId
    });
    return res.json({
      success: true,
      message: `${result.service.name} recovered`,
      data: serializeService(result.service),
      incident: result.incident ? serializeIncident(result.incident) : null
    });
  }
);

app.use((req, res, next) => {
  next(new HttpError(404, "Endpoint not found"));
});

app.use(serializeError);

export default app;
