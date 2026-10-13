export function getAllowedDashboardOrigins() {
  return [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    ...(process.env.CLIENT_ORIGIN || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  ];
}
