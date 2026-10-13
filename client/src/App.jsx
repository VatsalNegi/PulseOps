
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { io } from "socket.io-client";
import { API_URL, SOCKET_URL } from "./api.js";
import "./App.css";

const HistoricalMetrics = lazy(() => import("./HistoricalMetrics.jsx"));
const Experiments = lazy(() => import("./Experiments.jsx"));

function App() {
  const [page, setPage] = useState("overview");
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [notice, setNotice] = useState("");
  const [incidents, setIncidents] = useState([]);
  const [incidentsLoading, setIncidentsLoading] = useState(false);
  const [incidentsError, setIncidentsError] = useState("");
  const [incidentFilter, setIncidentFilter] = useState("all");
  const [realtimeStatus, setRealtimeStatus] = useState("connecting");
  const [metricEventIds, setMetricEventIds] = useState({});
  const [experimentRevision, setExperimentRevision] = useState(0);

  const fetchServices = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/services`);
      if (!response.ok) throw new Error("Could not fetch services");

      const result = await response.json();
      setServices(result.data);
      setError("");
    } catch {
      setError("Cannot connect to the PulseOps API. Is the backend running?");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchIncidents = useCallback(async () => {
    setIncidentsLoading(true);
    setIncidentsError("");

    try {
      const response = await fetch(`${API_URL}/incidents`);
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.message || "Could not fetch incidents");
      }
      if (!Array.isArray(result.data)) {
        throw new Error("The incidents API returned an invalid response");
      }

      setIncidents(result.data);
    } catch (err) {
      setIncidentsError(
        err.message || "Cannot connect to the PulseOps API. Is the backend running?"
      );
    } finally {
      setIncidentsLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialFetch = setTimeout(fetchServices, 0);
    const timer = setInterval(fetchServices, 3000);
    return () => {
      clearTimeout(initialFetch);
      clearInterval(timer);
    };
  }, [fetchServices]);

  useEffect(() => {
    const socket = io(SOCKET_URL, {
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000
    });
    const refreshServices = () => {
      fetchServices();
    };
    const refreshIncidents = () => {
      fetchIncidents();
    };
    const handleMetricSample = (payload) => {
      if (
        typeof payload?.serviceId === "string" &&
        typeof payload?.eventId === "string"
      ) {
        setMetricEventIds((current) => ({
          ...current,
          [payload.serviceId]: payload.eventId
        }));
      }
    };
    const handleExperimentUpdate = () => {
      setExperimentRevision((revision) => revision + 1);
    };
    const handleConnect = () => {
      setRealtimeStatus("connected");
      fetchServices();
      fetchIncidents();
    };
    const handleDisconnect = () => {
      setRealtimeStatus("reconnecting");
    };
    const handleConnectError = () => {
      setRealtimeStatus("reconnecting");
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleConnectError);
    socket.on("service:failure", refreshServices);
    socket.on("service:recovered", refreshServices);
    socket.on("service:probe_updated", refreshServices);
    socket.on("incident:created", refreshIncidents);
    socket.on("incident:resolved", refreshIncidents);
    socket.on("metrics:sample", handleMetricSample);
    socket.on("experiment:updated", handleExperimentUpdate);

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect_error", handleConnectError);
      socket.off("service:failure", refreshServices);
      socket.off("service:recovered", refreshServices);
      socket.off("service:probe_updated", refreshServices);
      socket.off("incident:created", refreshIncidents);
      socket.off("incident:resolved", refreshIncidents);
      socket.off("metrics:sample", handleMetricSample);
      socket.off("experiment:updated", handleExperimentUpdate);
      socket.disconnect();
    };
  }, [fetchIncidents, fetchServices]);

  async function changeService(id, action) {
    setBusyId(id);
    setNotice("");

    try {
      const response = await fetch(
        `${API_URL}/services/${id}/${action}`,
        { method: "POST" }
      );
      const result = await response.json();

      if (!response.ok) throw new Error(result.message || "Action failed");

      setNotice(result.message);
      await fetchServices();
    } catch (err) {
      setNotice(err.message || "Could not update service");
    } finally {
      setBusyId(null);
    }
  }

  const healthyCount = services.filter(
    (service) => service.probeStatus === "healthy"
  ).length;
  const degradedCount = services.filter(
    (service) => service.probeStatus === "degraded"
  ).length;
  const unconfiguredCount = services.filter(
    (service) => !service.probeConfigured
  ).length;
  const unknownProbeCount = services.filter(
    (service) =>
      service.probeConfigured &&
      !["healthy", "degraded"].includes(service.probeStatus)
  ).length;
  const platformStatus =
    services.length === 0
      ? "No services"
      : degradedCount
      ? "Warning"
      : unknownProbeCount
      ? "Checking"
      : unconfiguredCount === services.length
      ? "Unconfigured"
      : unconfiguredCount
      ? "Partial"
      : "Healthy";
  const visibleIncidents = incidents.filter(
    (incident) =>
      incidentFilter === "all" || incident.status === incidentFilter
  );

  function formatTimestamp(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "—"
      : date.toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short"
        });
  }

  function showIncidents() {
    setPage("incidents");
    fetchIncidents();
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-icon">P</span>
          <span>Pulse<span className="brand-accent">Ops</span></span>
        </div>

        <p className="nav-label">MONITORING</p>
        <button
          className={`nav-item ${page === "overview" ? "active" : ""}`}
          onClick={() => setPage("overview")}
          aria-current={page === "overview" ? "page" : undefined}
        >
          ◈ &nbsp; Overview
        </button>
        <button
          className={`nav-item ${page === "services" ? "active" : ""}`}
          onClick={() => setPage("services")}
          aria-current={page === "services" ? "page" : undefined}
        >
          ⌁ &nbsp; Services
        </button>
        <button
          className={`nav-item ${page === "incidents" ? "active" : ""}`}
          onClick={showIncidents}
          aria-current={page === "incidents" ? "page" : undefined}
        >
          ⚠ &nbsp; Incidents
        </button>
        <button
          className={`nav-item ${page === "metrics" ? "active" : ""}`}
          onClick={() => setPage("metrics")}
          aria-current={page === "metrics" ? "page" : undefined}
        >
          ◷ &nbsp; Metrics
        </button>
        <button
          className={`nav-item ${page === "experiments" ? "active" : ""}`}
          onClick={() => setPage("experiments")}
          aria-current={page === "experiments" ? "page" : undefined}
        >
          ◷ &nbsp; Experiments
        </button>

        <div className="sidebar-bottom">
          <div className="live-dot" />
          Simulator environment
          <small>Local development</small>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <p className="eyebrow">
              INFRASTRUCTURE / {page.toUpperCase()}
            </p>
            <h1>
              {page === "overview"
                ? "System Overview"
                : page === "services"
                ? "Monitored Services"
                : page === "incidents"
                ? "Incident History"
                : page === "experiments"
                ? "Experiments"
                : "Historical Metrics"}
            </h1>
            <p className="subtitle">
              {page === "overview"
                ? "Monitor your services and simulate infrastructure failures."
                : page === "services"
                ? "Review service health and use the simulator recovery controls."
                : page === "incidents"
                ? "Review active and resolved incidents across your services."
                : page === "experiments"
                ? "Experiment workflows are not yet available in PulseOps."
                : "Review real HTTP probe latency and service samples."}
            </p>
          </div>

          <div
            className={`connection ${realtimeStatus}`}
            role="status"
            aria-live="polite"
          >
            <span className="live-dot" />
            {realtimeStatus === "connected"
              ? "Live updates connected"
              : "Reconnecting live updates"}
          </div>
        </header>

        {(page === "overview" || page === "services") && <>
        <section className="summary-grid">
          <article className="summary-card">
            <span className="metric-label">TOTAL SERVICES</span>
            <strong>{services.length}</strong>
            <span className="metric-note">Registered services</span>
          </article>

          <article className="summary-card">
            <span className="metric-label">PROBE-HEALTHY SERVICES</span>
            <strong className="green">{healthyCount}</strong>
            <span className="metric-note">Based on real HTTP probes</span>
          </article>

          <article className="summary-card">
            <span className="metric-label">PROBE-DEGRADED SERVICES</span>
            <strong className="red">{degradedCount}</strong>
            <span className="metric-note">Failure threshold reached</span>
          </article>

          <article className="summary-card">
            <span className="metric-label">PLATFORM STATUS</span>
            <strong
              className={platformStatus === "Warning" ? "red" : platformStatus === "Healthy" ? "green" : ""}
            >
              {platformStatus}
            </strong>
            <span className="metric-note">Probe configuration and results</span>
          </article>
        </section>

        {notice && (
          <div className="notice" role="status">
            {notice}
            <button onClick={() => setNotice("")}>Dismiss</button>
          </div>
        )}

        {error && <div className="error-banner">{error}</div>}

        <section className="section">
          <div className="section-heading">
            <div>
              <h2>Monitored Services</h2>
              <p>Real probe health is separate from the local failure simulator.</p>
            </div>
            <button className="secondary-button" onClick={fetchServices}>
              ↻ Refresh
            </button>
          </div>

          {loading ? (
            <p className="empty-state">Loading services...</p>
          ) : (
            <div className="service-list">
              {services.map((service) => (
                <article className="service-card" key={service.id}>
                  <div className="service-main">
                    <div className={`service-icon ${service.probeStatus}`}>
                      {service.name.startsWith("User")
                        ? "U"
                        : service.name.startsWith("Order")
                        ? "O"
                        : "P"}
                    </div>

                    <div className="service-info">
                      <h3>{service.name}</h3>
                      <p>{service.id}</p>
                    </div>
                  </div>

                  <div className="latency">
                    <span>HTTP PROBE LATENCY</span>
                    <strong>
                      {typeof service.lastProbeLatencyMs === "number"
                        ? `${service.lastProbeLatencyMs.toLocaleString(undefined, {
                            maximumFractionDigits: 1
                          })} ms`
                        : "No measurement"}
                    </strong>
                    <small>
                      {service.probeConfigured ? "Real HTTP probe" : "Unconfigured"}
                      {" · Last check: "}
                      {formatTimestamp(service.lastProbeAt)}
                    </small>
                    {service.probeConfigured &&
                      service.lastProbeOutcome !== "success" && (
                        <small>Result: {service.lastProbeOutcome}</small>
                      )}
                    {service.lastProbeHttpStatus && (
                      <small>HTTP status: {service.lastProbeHttpStatus}</small>
                    )}
                  </div>

                  <div className="service-actions">
                    <span className={`status-pill ${service.probeStatus}`}>
                      <span className="status-dot" />
                      Probe: {service.probeStatus}
                    </span>
                    <span className={`status-pill simulator-status ${service.status}`}>
                      Simulator: {service.status}
                    </span>

                    <button
                      className="danger-button"
                      disabled={busyId === service.id ||
                        service.status !== "healthy"}
                      onClick={() => changeService(service.id, "failure")}
                    >
                      Inject Failure
                    </button>

                    <button
                      className="recover-button"
                      disabled={busyId === service.id ||
                        service.status === "healthy"}
                      onClick={() => changeService(service.id, "recover")}
                    >
                      Recover
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="section experiment-panel">
          <div>
            <p className="eyebrow">RELIABILITY LAB</p>
            <h2>Failure Simulation</h2>
            <p>
              Inject a controlled failure into a healthy service, observe
              its degraded status, and recover it when ready.
            </p>
          </div>
          <div className="experiment-icon">⌁</div>
        </section>

        <footer>
          PulseOps · Infrastructure Reliability Lab
          <span>Local simulator · Refreshes every 3 seconds</span>
        </footer>
        </>}

        {page === "experiments" && (
          <Suspense
            fallback={
              <p className="empty-state" role="status">
                Loading experiments…
              </p>
            }
          >
            <Experiments
              services={services}
              revision={experimentRevision}
            />
          </Suspense>
        )}

        {page === "metrics" && (
          <Suspense
            fallback={
              <p className="empty-state" role="status">
                Loading the metrics dashboard…
              </p>
            }
          >
            <HistoricalMetrics
              services={services}
              metricEventIds={metricEventIds}
            />
          </Suspense>
        )}

        {page === "incidents" && (
          <section className="section incident-section">
            <div className="section-heading">
              <div>
                <h2>Incident History</h2>
                <p>{incidents.length} total incidents</p>
              </div>
              <button
                className="secondary-button"
                onClick={fetchIncidents}
                disabled={incidentsLoading}
              >
                {incidentsLoading ? "Refreshing..." : "↻ Refresh"}
              </button>
            </div>

            <div className="incident-filters" aria-label="Filter incidents">
              {["all", "open", "resolved"].map((filter) => (
                <button
                  className={`filter-button ${incidentFilter === filter ? "active" : ""}`}
                  key={filter}
                  onClick={() => setIncidentFilter(filter)}
                  aria-pressed={incidentFilter === filter}
                >
                  {filter === "all"
                    ? `All (${incidents.length})`
                    : `${filter[0].toUpperCase()}${filter.slice(1)} (${incidents.filter(
                        (incident) => incident.status === filter
                      ).length})`}
                </button>
              ))}
            </div>

            {incidentsError && (
              <div className="error-banner incident-error" role="alert">
                <span>{incidentsError}</span>
                <button
                  className="secondary-button"
                  onClick={fetchIncidents}
                  disabled={incidentsLoading}
                >
                  Try again
                </button>
              </div>
            )}

            {incidentsLoading ? (
              <p className="empty-state" role="status">Loading incidents...</p>
            ) : incidentsError ? null : visibleIncidents.length === 0 ? (
              <p className="empty-state">
                {incidents.length === 0
                  ? "No incidents yet. Simulate a service failure from the overview to create one."
                  : `No ${incidentFilter === "all" ? "" : `${incidentFilter} `}incidents found.`}
              </p>
            ) : (
              <div className="incident-list">
                {visibleIncidents.map((incident) => (
                  <article className="incident-card" key={incident.id}>
                    <div className="incident-card-heading">
                      <div>
                        <p className="incident-service">
                          {incident.serviceName || incident.serviceId || "Unknown service"}
                        </p>
                        <h3>{incident.title || "Service incident"}</h3>
                      </div>
                      <div className="incident-badges">
                        <span className={`incident-source ${incident.source || "simulator"}`}>
                          {incident.source === "http_probe"
                            ? "HTTP probe"
                            : "Simulator"}
                        </span>
                        <span className={`severity-pill ${incident.severity || "unknown"}`}>
                          {incident.severity || "unknown"}
                        </span>
                        <span className={`incident-status ${incident.status || "unknown"}`}>
                          {incident.status || "unknown"}
                        </span>
                      </div>
                    </div>
                    <p className="incident-description">
                      {incident.description || "No description provided."}
                    </p>
                    <div className="incident-timestamps">
                      <div>
                        <span>CREATED</span>
                        <time dateTime={incident.createdAt || undefined}>
                          {formatTimestamp(incident.createdAt)}
                        </time>
                      </div>
                      <div>
                        <span>RESOLVED</span>
                        <time dateTime={incident.resolvedAt || undefined}>
                          {formatTimestamp(incident.resolvedAt)}
                        </time>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

export default App;
