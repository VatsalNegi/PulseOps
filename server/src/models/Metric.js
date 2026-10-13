import mongoose from "mongoose";
import { DEFAULT_SERVICES } from "../config/services.js";

const metricSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    serviceId: {
      type: String,
      enum: DEFAULT_SERVICES.map((service) => service.id),
      required: true
    },
    measuredAt: { type: Date, required: true },
    latencyMs: { type: Number, min: 0, default: null },
    status: {
      type: String,
      enum: ["healthy", "degraded", "unconfigured"],
      required: true
    },
    source: {
      type: String,
      enum: ["simulated", "http_probe"],
      required: true
    },
    outcome: {
      type: String,
      enum: [
        "success",
        "unhealthy_http_response",
        "timeout",
        "connection_error",
        "unconfigured",
        "unsafe_endpoint"
      ],
      default: "success",
      required: true
    },
    httpStatusCode: { type: Number, min: 100, max: 599, default: null },
    failureCategory: {
      type: String,
      enum: [
        "timeout",
        "connection_error",
        "unhealthy_http_response",
        "unconfigured",
        "unsafe_endpoint"
      ],
      default: null
    },
    samplingIntervalMs: { type: Number, min: 1, required: true },
    expiresAt: { type: Date, required: true }
  },
  { versionKey: false }
);

metricSchema.index(
  { serviceId: 1, measuredAt: -1 },
  { name: "service_metrics_by_time" }
);
metricSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: "metrics_retention_ttl" }
);

export default mongoose.model("Metric", metricSchema);
