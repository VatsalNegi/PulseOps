import dotenv from "dotenv";
import mongoose from "mongoose";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import app from "./app.js";
import { initializeDatabase } from "./db/initializeDatabase.js";
import { loadMetricsConfig } from "./config/metrics.js";
import { loadHealthEndpoints } from "./config/healthEndpoints.js";
import {
  startHttpProbeCollection,
  stopHttpProbeCollection
} from "./services/httpProbeCollector.js";
import {
  startExperimentManager,
  stopExperimentManager
} from "./services/experimentManager.js";
import {
  attachSocketServer,
  closeSocketServer
} from "./realtime/index.js";
import { logger } from "./utils/logger.js";

dotenv.config();
let mongoLifecycleLoggingRegistered = false;

function registerMongoLifecycleLogging() {
  if (mongoLifecycleLoggingRegistered) return;
  mongoLifecycleLoggingRegistered = true;

  mongoose.connection.on("disconnected", () => {
    logger.warn("mongodb.disconnected");
  });
  mongoose.connection.on("error", (error) => {
    logger.error("mongodb.connection_error", {
      errorName: error.name || "Error"
    });
  });
}

export async function startServer({
  port = process.env.PORT || 5000,
  host = process.env.HOST,
  mongodbUri = process.env.MONGODB_URI,
  shutdownTimeoutMs = 10000,
  installSignalHandlers = false,
  metricsConfig = loadMetricsConfig()
} = {}) {
  const healthEndpoints = loadHealthEndpoints();
  registerMongoLifecycleLogging();
  await initializeDatabase(mongodbUri);

  const server = createServer(app);
  const io = attachSocketServer(server);
  let metricsCollector;
  try {
    server.listen({ port, ...(host ? { host } : {}) });
    await new Promise((resolveListening, rejectListening) => {
      server.once("listening", resolveListening);
      server.once("error", rejectListening);
    });
    await startExperimentManager();
    metricsCollector = await startHttpProbeCollection(
      metricsConfig,
      healthEndpoints
    );
  } catch (error) {
    await stopExperimentManager();
    await stopHttpProbeCollection();
    await closeSocketServer(io);
    if (server.listening) {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
    await mongoose.disconnect();
    throw error;
  }

  const address = server.address();
  logger.info("server.started", {
    host: typeof address === "object" && address ? address.address : host,
    port: typeof address === "object" && address ? address.port : port
  });

  let shutdownPromise;
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      logger.info("server.shutdown_started");
      let shutdownError;
      try {
        await stopExperimentManager();
      } catch (error) {
        shutdownError = error;
        logger.error("experiment.shutdown_cleanup_failed", {
          errorName: error.name || "Error"
        });
      }
      try {
        await stopHttpProbeCollection();
      } catch (error) {
        shutdownError ||= error;
        logger.error("metrics.http_probe_shutdown_failed", {
          errorName: error.name || "Error"
        });
      }
      const closePromise = closeSocketServer(io);
      const timeout = setTimeout(() => {
        logger.warn("server.shutdown_timeout", { timeoutMs: shutdownTimeoutMs });
        server.closeAllConnections?.();
      }, shutdownTimeoutMs);
      timeout.unref();

      server.closeIdleConnections?.();
      try {
        await closePromise;
      } catch (error) {
        shutdownError ||= error;
      } finally {
        clearTimeout(timeout);
      }

      try {
        await mongoose.disconnect();
      } catch (error) {
        shutdownError ||= error;
      }
      logger.info("server.shutdown_complete");
      if (shutdownError) throw shutdownError;
    })();

    return shutdownPromise;
  };

  if (installSignalHandlers) {
    const handleSignal = (signal) => {
      logger.info("server.shutdown_signal", { signal });
      shutdown().then(
        () => {
          process.exitCode = signal === "SIGINT" ? 130 : 143;
        },
        (error) => {
          logger.error("server.shutdown_failed", {
            signal,
            errorName: error.name || "Error"
          });
          process.exitCode = 1;
        }
      );
    };

    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
  }

  return { server, io, metricsCollector, shutdown };
}

async function main() {
  try {
    await startServer({ installSignalHandlers: true });
  } catch (error) {
    logger.error("server.startup_failed", {
      errorName: error.name || "Error",
      message: error.message
    });
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
