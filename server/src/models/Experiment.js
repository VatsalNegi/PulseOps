import mongoose from "mongoose";
import { DEFAULT_SERVICES } from "../config/services.js";

const experimentSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    serviceId: {
      type: String,
      enum: DEFAULT_SERVICES.map((service) => service.id),
      required: true
    },
    activeServiceId: {
      type: String,
      enum: DEFAULT_SERVICES.map((service) => service.id)
    },
    type: {
      type: String,
      enum: ["simulated_service_failure"],
      required: true
    },
    durationSeconds: { type: Number, min: 1, max: 60, required: true },
    status: {
      type: String,
      enum: ["pending", "running", "completed", "cancelled", "failed"],
      required: true
    },
    createdAt: { type: Date, required: true, default: Date.now },
    startedAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    outcome: { type: String, default: null }
  },
  { versionKey: false }
);

experimentSchema.index(
  { activeServiceId: 1 },
  { unique: true, sparse: true, name: "one_active_experiment_per_service" }
);
experimentSchema.index(
  { createdAt: -1 },
  { name: "experiment_history_by_created_at" }
);

export default mongoose.model("Experiment", experimentSchema);
