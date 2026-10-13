import mongoose from "mongoose";
import Incident from "../models/Incident.js";
import Metric from "../models/Metric.js";
import Experiment from "../models/Experiment.js";
import Service from "../models/Service.js";
import { DEFAULT_SERVICES } from "../config/services.js";
import { logger } from "../utils/logger.js";

export async function seedDefaultServices() {
  await Promise.all(
    DEFAULT_SERVICES.map((service) =>
      Service.updateOne(
        { _id: service.id },
        {
          $setOnInsert: {
            name: service.name,
            status: "healthy",
            latency: service.latency
          }
        },
        { upsert: true }
      )
    )
  );
}

export async function initializeDatabase(mongodbUri) {
  if (!mongodbUri) {
    throw new Error("MONGODB_URI is required. Configure it in server/.env.");
  }

  try {
    await mongoose.connect(mongodbUri);
    logger.info("mongodb.connected", { database: mongoose.connection.name });
    await Promise.all([
      Service.init(),
      Incident.init(),
      Metric.init(),
      Experiment.init()
    ]);
    await seedDefaultServices();
    logger.info("mongodb.initialized", { database: mongoose.connection.name });
  } catch (error) {
    await mongoose.disconnect();
    throw new Error(
      "MongoDB connection or initialization failed. Verify MONGODB_URI, database availability, and model indexes.",
      { cause: error }
    );
  }
}
