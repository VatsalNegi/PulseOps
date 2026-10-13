import { Server } from "socket.io";
import { getAllowedDashboardOrigins } from "../config/origins.js";

let activeIo;

export function attachSocketServer(httpServer) {
  if (activeIo) {
    throw new Error("A Socket.IO server is already attached.");
  }

  const allowedOrigins = new Set(getAllowedDashboardOrigins());
  const io = new Server(httpServer, {
    cors: {
      origin: [...allowedOrigins],
      methods: ["GET", "POST"]
    },
    allowRequest(request, callback) {
      const origin = request.headers.origin;
      callback(null, !origin || allowedOrigins.has(origin));
    }
  });

  activeIo = io;
  io.once("close", () => {
    if (activeIo === io) activeIo = undefined;
  });

  return io;
}

export function closeSocketServer(io = activeIo) {
  if (!io) return Promise.resolve();
  if (activeIo === io) activeIo = undefined;

  return new Promise((resolveClose) => {
    io.close(resolveClose);
  });
}

export function emitRealtimeEvent(eventName, payload) {
  activeIo?.emit(eventName, payload);
}
