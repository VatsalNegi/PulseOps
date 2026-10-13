import mongoose from "mongoose";

const serviceSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true },
    status: {
      type: String,
      enum: ["healthy", "degraded"],
      required: true
    },
    latency: { type: Number, min: 0, required: true },
    activeExperimentId: { type: String, default: null },
    probeStatus: {
      type: String,
      enum: ["unconfigured", "unknown", "healthy", "degraded"],
      default: "unconfigured"
    },
    probeConfigured: { type: Boolean, default: false },
    probeFailureCount: { type: Number, min: 0, default: 0 },
    probeSuccessCount: { type: Number, min: 0, default: 0 },
    lastProbeAt: { type: Date, default: null },
    lastProbeOutcome: { type: String, default: "unconfigured" },
    lastProbeLatencyMs: { type: Number, min: 0, default: null },
    lastProbeHttpStatus: { type: Number, min: 100, max: 599, default: null }
  },
  { versionKey: false, timestamps: true }
);

export default mongoose.model("Service", serviceSchema);
