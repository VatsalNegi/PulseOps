import { Router } from "express";
import Experiment from "../models/Experiment.js";
import HttpError from "../utils/HttpError.js";
import {
  cancelExperiment,
  createExperiment,
  serializeExperiment
} from "../services/experimentManager.js";

const router = Router();
const MAX_HISTORY_LIMIT = 100;

router.post("/", async (req, res) => {
  if (
    !req.body ||
    typeof req.body !== "object" ||
    Array.isArray(req.body) ||
    Object.keys(req.body).some(
      (key) => !["serviceId", "durationSeconds"].includes(key)
    )
  ) {
    throw new HttpError(
      400,
      "Request must include only serviceId and durationSeconds"
    );
  }

  const experiment = await createExperiment(req.body);
  return res.status(201).json({
    success: true,
    data: serializeExperiment(experiment)
  });
});

router.get("/", async (req, res) => {
  const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
  if (
    Array.isArray(req.query.limit) ||
    !/^\d+$/.test(String(req.query.limit ?? "20")) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_HISTORY_LIMIT
  ) {
    throw new HttpError(
      400,
      `limit must be a whole number between 1 and ${MAX_HISTORY_LIMIT}`
    );
  }
  const experiments = await Experiment.find()
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit)
    .lean();
  return res.json({
    success: true,
    count: experiments.length,
    data: experiments.map(serializeExperiment)
  });
});

router.get("/:id", async (req, res) => {
  const experiment = await Experiment.findById(req.params.id).lean();
  if (!experiment) throw new HttpError(404, "Experiment not found");
  return res.json({
    success: true,
    data: serializeExperiment(experiment)
  });
});

router.post("/:id/cancel", async (req, res) => {
  if (req.body !== undefined) {
    throw new HttpError(400, "Request body is not supported");
  }
  const experiment = await cancelExperiment(req.params.id);
  return res.json({
    success: true,
    data: serializeExperiment(experiment)
  });
});

export default router;
