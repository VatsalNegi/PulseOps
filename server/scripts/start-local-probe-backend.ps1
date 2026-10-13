$ErrorActionPreference = "Stop"

$env:PORT = "5001"
$env:HOST = "127.0.0.1"
$env:NODE_ENV = "development"
$env:MONGODB_URI = "mongodb://127.0.0.1:27017/pulseops"
$env:HEALTH_ENDPOINTS_JSON = '{"user-service":"http://127.0.0.1:5055/health"}'
$env:HEALTH_ALLOWED_HOSTS = "127.0.0.1"
$env:HEALTH_ALLOW_LOCAL_HTTP = "true"
$env:METRICS_ENABLED = "true"
$env:METRICS_SAMPLING_INTERVAL_MS = "1000"
$env:HEALTH_PROBE_TIMEOUT_MS = "500"
$env:HEALTH_FAILURE_THRESHOLD = "3"
$env:HEALTH_RECOVERY_THRESHOLD = "2"

Write-Host "Starting PulseOps against the development database with a local-only probe configuration."
Write-Host "The endpoint URL is server-side configuration and is not sent to the frontend."
node src/server.js
