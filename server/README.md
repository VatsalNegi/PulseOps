# PulseOps backend

The backend is an Express 5 API backed by MongoDB through Mongoose. `src/app.js`
defines middleware and routes and has no listener or database startup side
effects. `src/server.js` initializes MongoDB and model indexes, seeds missing
default services, and only then begins accepting requests.

## Local setup

Start the MongoDB container if it is not already running:

```powershell
docker start pulseops-mongo
```

Configure `MONGODB_URI` in `server/.env` and start the API:

```powershell
Set-Location C:\Users\Victus\pulseops\server
npm run dev
```

The backend `.gitignore` excludes `.env`, dependencies, and test coverage
output. Keep real connection credentials in `.env` or the deployment
environment, never in `.env.example`.

The default API port is `5000`; override it with `PORT`. The dashboard origin
`http://localhost:5173` is allowed by default. Set `CLIENT_ORIGIN` to a
comma-separated list of additional allowed browser origins. Requests without
an `Origin` header remain supported for local API clients. CORS is a browser
policy, not authentication; do not expose the simulator publicly without
adding authentication and authorization.

## Real-time updates

The Socket.IO server is attached to the same HTTP server as Express after
MongoDB initialization and before the listener accepts requests. Socket.IO
uses the same allowed origins as REST CORS, including `CLIENT_ORIGIN`, and
rejects browser/WebSocket handshakes from other origins. The app module remains
safe to import without opening a socket, connecting to MongoDB, or starting a
listener.

The React client connects to the API origin (default `http://localhost:5000`).
Set `VITE_API_URL` to the full API base, such as
`https://pulseops.example/api`, to change the backend used by the dashboard.
The client automatically reconnects, refreshes services and incidents on
reconnection, and removes its event listeners and socket when the component
unmounts. The existing service polling and REST actions remain in place.
Probe health changes emit `service:probe_updated`; every persisted probe
sample emits `metrics:sample`. These broadcasts are transient, and the client
reloads the authoritative state through REST.

All events use the following payload shape; `incident` is `null` when a
service is recovered without an open incident:

```json
{
  "eventId": "a unique event identifier",
  "occurredAt": "2026-10-13T12:00:00.000Z",
  "service": {
    "id": "payment-service",
    "name": "Payment Service",
    "status": "degraded",
    "latency": 5000
  },
  "incident": {
    "id": "incident identifier",
    "serviceId": "payment-service",
    "serviceName": "Payment Service",
    "title": "Payment Service is degraded",
    "description": "Response latency increased to 5000 ms.",
    "severity": "critical",
    "status": "open",
    "createdAt": "2026-10-13T12:00:00.000Z",
    "resolvedAt": null
  }
}
```

| Event | Emitted after |
| --- | --- |
| `service:failure` | Service is persisted as degraded and its open incident is persisted. |
| `incident:created` | New incident is persisted. |
| `service:recovered` | Service recovery and open-incident resolution have completed. |
| `incident:resolved` | Existing incident is persisted as resolved. |
| `service:probe_updated` | Probe status crosses a failure or recovery threshold. |
| `metrics:sample` | A metric sample is persisted. |

Events are in-process broadcasts and are not an event log. A disconnected
client may miss a broadcast; on reconnect the dashboard reloads current state
from the REST endpoints. Run the backend integration tests to exercise an
allowed Socket.IO connection, persisted failure/recovery events, and rejection
of a disallowed origin:

```powershell
Set-Location C:\Users\Victus\pulseops\server
$env:MONGODB_TEST_URI = "mongodb://127.0.0.1:27017/pulseops_test"
npm test
```

For a manual end-to-end check, run the API and Vite dashboard, open the browser
developer tools' Network panel filtered to `socket.io`, then use the dashboard
failure and recovery controls. The service cards and incident history reload
when their corresponding Socket.IO events arrive.

```powershell
# Terminal 1
Set-Location C:\Users\Victus\pulseops\server
npm run dev

# Terminal 2
Set-Location C:\Users\Victus\pulseops\client
npm run dev
```

## API

Failure and recovery actions accept no request body. JSON requests are limited
to 16 KiB, and malformed JSON receives a JSON `400` response.

| Method and path | Success | Behavior |
| --- | --- | --- |
| `GET /api/health` | `200` | `{ "success": true, "message": "PulseOps API is running" }` |
| `GET /api/services` | `200` | `{ "success": true, "count": 3, "data": [...] }`; default service order is User, Order, Payment. |
| `GET /api/incidents` | `200` | `{ "success": true, "count": n, "data": [...] }`; newest incidents are listed first. |
| `POST /api/services/:id/failure` | `200` | Degrades a healthy service and creates its open incident. A repeated failure retains the existing “already degraded” response, without an `incident` property. |
| `POST /api/services/:id/recover` | `200` | Restores baseline latency and resolves any open incident. Repeating recovery is safe. |

Failure responses use `{ "success": false, "message": "..." }`. Invalid service
ID syntax returns `400`; a valid but unsupported service ID returns `404` with
`Service not found`. Unsupported request bodies return `400`. Payloads over the
JSON limit return `413`. Unexpected failures return a generic `500` response;
internal errors are logged without returning stack traces or database details.

### Reliability experiments

The initial experiment type is a **simulated service failure**. It uses the
same service transition, incident creation/resolution, compensation, and
existing `service:failure`, `incident:created`, `incident:resolved`, and
`service:recovered` events as the manual simulator controls. It does not
interact with real infrastructure. An experiment duration is a whole number
of seconds from 1 through 60.

| Method and path | Behavior |
| --- | --- |
| `POST /api/experiments` | Create and start an experiment. JSON body: `{ "serviceId": "payment-service", "durationSeconds": 10 }`. Returns `201` with the experiment in `data`. |
| `GET /api/experiments?limit=20` | List recent experiment history, newest first. `limit` defaults to 20 and is capped at 100. |
| `GET /api/experiments/:id` | Get an experiment by its ID. |
| `POST /api/experiments/:id/cancel` | Cancel a running experiment and recover its owned service. |

Experiment records persist type, target service, requested duration, state,
start/end timestamps, and outcome. States are `pending`, `running`,
`completed`, `cancelled`, and `failed`. `experiment:updated` Socket.IO events
carry `{ eventId, experiment }` after the experiment state has been persisted.
The browser reloads history through REST when this transient event arrives.

Only one experiment may be pending or running for a given service. A unique
MongoDB index enforces that rule across API instances. The service document
also records the owning experiment ID; manual failure/recovery requests cannot
take over a service while its experiment is active. The experiment manager
automatically recovers the service at expiration, on cancellation, and during
graceful shutdown. At startup, pending/running records are reconciled: an
owned running experiment is resumed until its persisted deadline, while an
interrupted pending record is failed and safely recovered only if its owner
matches. If recovery fails, the experiment is marked failed and ownership is
retained so a later manual recovery can release it safely.

Scheduling is intentionally in-process and bounded by the three configured
services. MongoDB ownership and the unique active-experiment index prevent
duplicate ownership, but timers are not a distributed job queue and this
module is not a substitute for durable scheduling infrastructure in a
multi-instance production deployment. If the process is terminated without
graceful shutdown, startup reconciliation handles persisted active records.

In the dashboard, open **Experiments**, select a healthy service and a duration,
review the simulation configuration, then start or cancel it. Current elapsed
time and recent recorded outcomes are displayed from persisted API state.

### Historical metrics

The `Metric` collection stores one document per sampled service with the
service ID, UTC `measuredAt` timestamp, latency in milliseconds, service status,
measurement source, sampling interval, and indexed expiry timestamp. The
current sampler reads persisted simulator state and always writes
`source: "simulated"`; no HTTP probes or real network measurements are
currently performed.

Sampling starts only after database/index initialization and the HTTP/Socket.IO
server is listening. It samples immediately, then schedules the next cycle
after the configured interval. A collector allows at most one active sampling
cycle and waits for that cycle during shutdown. Each service write is isolated:
a failed sample is logged and does not prevent other services from being
sampled. Sampling may be disabled with `METRICS_ENABLED=false`.

Defaults and valid ranges:

| Variable | Default | Range |
| --- | --- | --- |
| `METRICS_ENABLED` | `true` | `true` or `false` |
| `METRICS_SAMPLING_INTERVAL_MS` | `30000` | `1000` to `86400000` milliseconds |
| `METRICS_RETENTION_DAYS` | `7` | `1` to `365` days |

Metrics receive `expiresAt = measuredAt + retention`. A MongoDB TTL index on
`expiresAt` removes expired records asynchronously; expiration is not
immediate and MongoDB's TTL monitor may take roughly a minute or longer to
delete a record after its expiry time. The retention window is applied when
each sample is written, so changing the configured retention does not rewrite
existing documents.

Read-only endpoints:

| Route | Query parameters | Response |
| --- | --- | --- |
| `GET /api/metrics` | Optional `serviceId`, `from`, `to`, `limit`, `source` | `{ success, count, total, limit, data }`; samples are newest first. Default limit is 100, maximum is 500. `source` is `simulated` or `http_probe` and defaults to `simulated`. |
| `GET /api/metrics/summary` | Optional `serviceId`, `from`, `to`, `source` | `{ success, data: { count, measurementCount, averageLatencyMs, minimumLatencyMs, maximumLatencyMs, byStatus, bySource } }`. |

`from` and `to` must be ISO timestamps with a timezone; both bounds are
inclusive, and `from` must be earlier than `to`. Invalid or unsupported query
parameters and limits outside 1–500 return the standard JSON `400` response.
The summary describes stored samples only; it does not calculate uptime or
infer health during missing sample intervals.

Examples:

```powershell
Invoke-RestMethod "http://localhost:5000/api/metrics?serviceId=payment-service&source=http_probe&limit=50"
Invoke-RestMethod "http://localhost:5000/api/metrics?from=2026-10-13T00:00:00.000Z&to=2026-10-14T00:00:00.000Z"
Invoke-RestMethod "http://localhost:5000/api/metrics/summary?serviceId=payment-service&source=http_probe"
```

After a metric has been persisted, the server broadcasts `metrics:sample`:

```json
{
  "eventId": "metric document ID",
  "timestamp": "2026-10-13T12:00:00.000Z",
  "serviceId": "payment-service",
  "latencyMs": 5000,
  "status": "degraded",
  "source": "simulated"
}
```

Metrics broadcasts are transient and are not a durable event stream. REST
metrics endpoints and MongoDB remain the source of historical truth. A failed
Socket.IO emit does not remove an already persisted metric. The current
simulator samples only the three registered services, one document per
service per interval; at the defaults this is up to 8,640 samples per day
across all three services and 60,480 over seven days before asynchronous TTL
cleanup. Legacy simulated samples are retained for backward compatibility;
the production server no longer starts the synthetic collector. The summary
does not calculate measured uptime.

### Historical metrics dashboard

The React dashboard includes a **Metrics** page with a service selector, time
ranges of 15 minutes, 1 hour, 6 hours, and 24 hours, latency-over-time chart,
and average/minimum/maximum latency and sample-count summaries. It explicitly
requests `source=http_probe` and labels the records **Real HTTP probe**. The
summary covers all samples in the selected range; null-latency failures count
as samples but not as latency measurements. The chart requests at most 500
records and orders returned points chronologically. Existing `simulated`
records remain available by API but are not mixed into the real-probe chart.

### Real HTTP health probes

Production startup uses the HTTP probe collector; no synthetic metrics
scheduler is started. The endpoint map is empty by default, so services appear
as **Unconfigured** rather than being reported as healthy without a probe.
Endpoint URLs remain server-side and are never returned in API responses.

Configure `HEALTH_ENDPOINTS_JSON` as an object keyed by known service ID, and
list every external hostname in `HEALTH_ALLOWED_HOSTS`:

```dotenv
HEALTH_ENDPOINTS_JSON={"user-service":"https://health.example.net/status"}
HEALTH_ALLOWED_HOSTS=health.example.net
```

This URL is an illustrative placeholder, not a PulseOps service endpoint; only
configure a service you own or are authorized to monitor. External endpoints
must use HTTPS. Local HTTP demos require an explicitly configured loopback
endpoint, `HEALTH_ALLOW_LOCAL_HTTP=true`, and `NODE_ENV=development`; do not
enable that switch in production.

`METRICS_SAMPLING_INTERVAL_MS` defaults to 30,000 ms (minimum 1,000 ms).
`HEALTH_PROBE_TIMEOUT_MS` defaults to 5,000 ms. A completed 2xx response is
healthy; other statuses, including redirects, are unhealthy and redirects are
never followed. Timeout and connection failures are persisted with null
latency. Three consecutive failures (configurable through
`HEALTH_FAILURE_THRESHOLD`) mark probe health degraded and create at most one
open HTTP-probe incident per service. Two consecutive successes
(`HEALTH_RECOVERY_THRESHOLD`) recover probe health and resolve its incident.

Configured hostnames must be allowlisted. Their DNS answers are checked on
each probe and the selected public address is pinned for that request; any
private/reserved answer rejects the probe. The implementation rejects URL
credentials and fragments and does not follow redirects. These checks reduce
SSRF exposure but are not a substitute for outbound network firewall rules.
DNS/IP classification has limitations, and a hostname allowlist permits all
paths and ports on that host; use narrowly scoped health-check hosts and
restrict network egress. A DNS timeout bounds how long a check waits, but the
operating system's underlying resolver request cannot always be cancelled.

Probe scheduling is process-local. Run only one metrics-enabled backend
instance until a distributed lease/coordination mechanism is introduced;
multiple instances can otherwise issue duplicate probes and advance persisted
failure/recovery counters more quickly than the configured wall-clock policy.

Probe status and measurements are separate from the existing simulated
`status`/`latency` used by failure controls and experiments. Probe observations
are recorded while an experiment owns a service, but do not change or recover
the experiment-owned simulator state. Legacy records are tagged
`source=simulated`; new checks use `source=http_probe`. The metrics API keeps
the default source as `simulated` for backward compatibility, so clients must
request `source=http_probe` for real measurements.

#### Local probe demonstration

The repository includes an isolated deterministic endpoint bound only to
`127.0.0.1:5055`. It serves `/health` with HTTP 200 by default and can be
switched to HTTP 503 through its loopback-only `POST /__mode` control route.
It is a development test utility, not a monitored production service:

```powershell
# Terminal 1
Set-Location C:\Users\Victus\pulseops\server
node src\dev\localHealthServer.js

# Terminal 2
Set-Location C:\Users\Victus\pulseops\server
.\scripts\start-local-probe-backend.ps1
```

The backend launcher sets process-scoped configuration for
`user-service -> http://127.0.0.1:5055/health`, `NODE_ENV=development`,
`HEALTH_ALLOW_LOCAL_HTTP=true`, and an explicit `127.0.0.1` host entry.
`loadHealthEndpoints()` permits loopback based on the development flag and
does not consult the external-host allowlist for loopback; the allowlist entry
is explicit but does not replace the development-only safeguard. The launcher
explicitly targets the existing `pulseops` development database and does not
clear or reset it. Do not use this launcher in production.

Switch the endpoint to 503 and then back to 200 from another local PowerShell
terminal:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:5055/__mode `
  -ContentType "application/json" -Body '{"statusCode":503}'
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:5055/__mode `
  -ContentType "application/json" -Body '{"statusCode":200}'
```

The demo backend listens on `http://127.0.0.1:5001` to avoid colliding with a
separate application already using the usual development API port. With its
one-second interval and three-failure/two-success thresholds, inspect probe
records and service state using:

```powershell
Invoke-RestMethod "http://localhost:5001/api/metrics?serviceId=user-service&source=http_probe&limit=20"
Invoke-RestMethod "http://localhost:5001/api/metrics/summary?serviceId=user-service&source=http_probe"
Invoke-RestMethod "http://localhost:5001/api/services"
Invoke-RestMethod "http://localhost:5001/api/incidents"
```

To point a local Vite dashboard at the demo backend:

```powershell
Set-Location C:\Users\Victus\pulseops\client
$env:VITE_API_URL = "http://127.0.0.1:5001/api"
npm run dev
```

The `/__mode` control is only reachable on the same machine because the
endpoint binds to IPv4 loopback and rejects requests from non-loopback peer
addresses. The independent integration test exercises the HTTP server,
collector persistence, 503 incident threshold, two-success recovery, and
timeout/connection null-latency cases against only `pulseops_test`.

## Integration tests

Tests use a separate database and never fall back to `MONGODB_URI`. Configure
the test URI to the exact `pulseops_test` database:

```powershell
Set-Location C:\Users\Victus\pulseops\server
$env:MONGODB_TEST_URI = "mongodb://127.0.0.1:27017/pulseops_test"
npm test
```

The test suite checks the URI before connecting and verifies the active
Mongoose connection name before every cleanup. It uses targeted `deleteMany`
calls on the service and incident collections; it does not drop the database.
If the URI is missing or names another database, the tests fail before cleanup.

## Logging and operational behavior

Application logs are one JSON object per line with a timestamp, severity, and
event name. Lifecycle, request rejection/failure, simulated failure, recovery,
and incident creation/resolution events include relevant request, service, or
incident identifiers. Request bodies and environment variable values are not
logged.

On `SIGINT` or `SIGTERM`, the API stops accepting new connections, closes idle
connections, and gives in-flight requests up to 10 seconds to finish. After
that bound, remaining HTTP connections are closed and MongoDB is disconnected.
Importing `app.js` does not register signal handlers or start the server.

## State consistency

Failure and recovery operations are serialized per service within one Node.js
process. Conditional MongoDB updates ensure that only one operation at a time
can change a service from its expected prior state; the existing unique
partial index independently enforces at most one open incident per service.
If an incident write fails after a service transition, the API attempts a
conditional compensating service update and returns a generic server error.

These steps reduce inconsistency but are not a multi-document atomic
transaction. The local standalone MongoDB configuration does not provide
replica-set transactions. A process crash between the service update and
incident write, a failed compensation, or conflicting operations handled by
separate API processes can still leave service and incident state temporarily
out of sync. Strict cross-process atomicity requires a transaction-capable
replica set or a redesigned single-document event/state model.
