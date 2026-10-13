import { DEFAULT_SERVICES } from "./services.js";

const serviceIds = new Set(DEFAULT_SERVICES.map(({ id }) => id));
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function parseHostAllowlist(value = "") {
  const hosts = value
    .split(",")
    .map((host) => host.trim().toLowerCase().replace(/^\[|\]$/g, ""))
    .filter(Boolean);
  if (hosts.some((host) => !/^[a-z0-9.-]+$/.test(host) && host !== "::1")) {
    throw new Error("HEALTH_ALLOWED_HOSTS contains an invalid host.");
  }
  return new Set(hosts);
}

export function loadHealthEndpoints(env = process.env) {
  const raw = env.HEALTH_ENDPOINTS_JSON || "{}";
  let configured;
  try {
    configured = JSON.parse(raw);
  } catch {
    throw new Error("HEALTH_ENDPOINTS_JSON must contain valid JSON.");
  }
  if (
    !configured ||
    typeof configured !== "object" ||
    Array.isArray(configured)
  ) {
    throw new Error("HEALTH_ENDPOINTS_JSON must be a service-to-URL object.");
  }

  const allowLocalValue = env.HEALTH_ALLOW_LOCAL_HTTP ?? "false";
  if (!["true", "false"].includes(allowLocalValue.toLowerCase())) {
    throw new Error("HEALTH_ALLOW_LOCAL_HTTP must be true or false.");
  }
  const allowLocalHttp =
    allowLocalValue.toLowerCase() === "true" &&
    env.NODE_ENV === "development";
  const allowedHosts = parseHostAllowlist(env.HEALTH_ALLOWED_HOSTS);
  const endpoints = new Map();

  for (const [serviceId, endpoint] of Object.entries(configured)) {
    if (!serviceIds.has(serviceId)) {
      throw new Error(`HEALTH_ENDPOINTS_JSON contains unknown service: ${serviceId}`);
    }
    if (typeof endpoint !== "string" || endpoint.length > 2048) {
      throw new Error(`Health endpoint for ${serviceId} must be a URL string.`);
    }

    let url;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error(`Health endpoint for ${serviceId} must be a valid URL.`);
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (url.username || url.password || url.hash) {
      throw new Error(
        `Health endpoint for ${serviceId} cannot contain credentials or a fragment.`
      );
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error(`Health endpoint for ${serviceId} must use HTTP or HTTPS.`);
    }

    const isLocal = LOOPBACK_HOSTS.has(hostname);
    if (isLocal) {
      if (
        !allowLocalHttp ||
        (url.protocol !== "http:" && url.protocol !== "https:")
      ) {
        throw new Error(
          `Loopback health endpoint for ${serviceId} requires development-only HEALTH_ALLOW_LOCAL_HTTP=true.`
        );
      }
    } else {
      if (url.protocol !== "https:") {
        throw new Error(
          `External health endpoint for ${serviceId} must use HTTPS.`
        );
      }
      if (!allowedHosts.has(hostname)) {
        throw new Error(
          `Health endpoint host for ${serviceId} is not in HEALTH_ALLOWED_HOSTS.`
        );
      }
    }

    endpoints.set(serviceId, Object.freeze({
      url: url.toString(),
      hostname,
      local: isLocal
    }));
  }

  return endpoints;
}

export function isPublicAddress(address) {
  const parts = address.toLowerCase().split("%")[0];
  const ipv4Parts = parts.split(".").map(Number);
  if (ipv4Parts.length === 4 && ipv4Parts.every(Number.isInteger)) {
    const [a, b] = ipv4Parts;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 2) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && ipv4Parts[2] === 100) ||
      (a === 203 && b === 0 && ipv4Parts[2] === 113) ||
      a >= 224
    );
  }

  const normalized = parts.replace(/^\[|\]$/g, "");
  if (normalized === "::1" || normalized === "::") return false;
  if (normalized.startsWith("::ffff:")) {
    return isPublicAddress(normalized.slice(7));
  }
  const firstHextet = Number.parseInt(normalized.split(":")[0] || "0", 16);
  return (
    firstHextet >= 0x2000 &&
    firstHextet <= 0x3fff &&
    !normalized.startsWith("2001:db8:")
  );
}
