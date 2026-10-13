export const API_URL = (
  import.meta.env.VITE_API_URL || "http://localhost:5000/api"
).replace(/\/+$/, "");

export const SOCKET_URL = new URL(API_URL).origin;
