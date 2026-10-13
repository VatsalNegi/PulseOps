const DEFAULT_INTERVAL_MS = 30000;
const DEFAULT_RETENTION_DAYS = 7;
const MIN_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 86400000;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 365;
const DEFAULT_PROBE_TIMEOUT_MS = 5000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_RECOVERY_THRESHOLD = 2;

function parseInteger(value, name, defaultValue, min, max) {
  if (value === undefined || value === "") return defaultValue;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a whole number.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
  return parsed;
}

export function loadMetricsConfig(env = process.env) {
  const enabledValue = env.METRICS_ENABLED ?? "true";
  if (!["true", "false"].includes(enabledValue.toLowerCase())) {
    throw new Error("METRICS_ENABLED must be true or false.");
  }

  const samplingIntervalMs = parseInteger(
    env.METRICS_SAMPLING_INTERVAL_MS,
    "METRICS_SAMPLING_INTERVAL_MS",
    DEFAULT_INTERVAL_MS,
    MIN_INTERVAL_MS,
    MAX_INTERVAL_MS
  );
  const retentionDays = parseInteger(
    env.METRICS_RETENTION_DAYS,
    "METRICS_RETENTION_DAYS",
    DEFAULT_RETENTION_DAYS,
    MIN_RETENTION_DAYS,
    MAX_RETENTION_DAYS
  );
  const probeTimeoutMs = parseInteger(
    env.HEALTH_PROBE_TIMEOUT_MS,
    "HEALTH_PROBE_TIMEOUT_MS",
    DEFAULT_PROBE_TIMEOUT_MS,
    100,
    60000
  );
  const failureThreshold = parseInteger(
    env.HEALTH_FAILURE_THRESHOLD,
    "HEALTH_FAILURE_THRESHOLD",
    DEFAULT_FAILURE_THRESHOLD,
    1,
    10
  );
  const recoveryThreshold = parseInteger(
    env.HEALTH_RECOVERY_THRESHOLD,
    "HEALTH_RECOVERY_THRESHOLD",
    DEFAULT_RECOVERY_THRESHOLD,
    1,
    10
  );

  return Object.freeze({
    enabled: enabledValue.toLowerCase() === "true",
    samplingIntervalMs,
    retentionDays,
    retentionMs: retentionDays * 24 * 60 * 60 * 1000,
    probeTimeoutMs,
    failureThreshold,
    recoveryThreshold
  });
}
