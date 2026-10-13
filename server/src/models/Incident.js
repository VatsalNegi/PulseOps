import mongoose from "mongoose";

const incidentSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    serviceId: { type: String, required: true },
    serviceName: { type: String, required: true },
    title: { type: String, required: true },
    description: { type: String, required: true },
    source: {
      type: String,
      enum: ["simulator", "http_probe"],
      default: "simulator",
      required: true
    },
    severity: {
      type: String,
      enum: ["warning", "critical"],
      required: true
    },
    status: {
      type: String,
      enum: ["open", "resolved"],
      required: true,
      default: "open"
    },
    createdAt: { type: Date, required: true, default: Date.now },
    resolvedAt: { type: Date, default: null }
  },
  { versionKey: false }
);

incidentSchema.index(
  { serviceId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "open" },
    name: "one_open_incident_per_service"
  }
);

export default mongoose.model("Incident", incidentSchema);
