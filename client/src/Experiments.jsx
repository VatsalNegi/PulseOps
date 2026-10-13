import { useCallback, useEffect, useMemo, useState } from "react";
import { API_URL } from "./api.js";

const DURATIONS = [5, 10, 30, 60];
const ACTIVE_STATES = new Set(["pending", "running"]);

function formatTimestamp(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "—"
    : parsed.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short"
      });
}

function elapsedSeconds(experiment, now) {
  if (!experiment?.startedAt) return 0;
  const startedAt = Date.parse(experiment.startedAt);
  if (!Number.isFinite(startedAt)) return 0;
  return Math.max(
    0,
    Math.min(
      experiment.durationSeconds,
      Math.floor((now - startedAt) / 1000)
    )
  );
}

function Experiments({ services, revision }) {
  const [selectedServiceId, setSelectedServiceId] = useState("");
  const [durationSeconds, setDurationSeconds] = useState(10);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [clock, setClock] = useState(0);

  const effectiveServiceId = services.some(
    (service) => service.id === selectedServiceId
  )
    ? selectedServiceId
    : services[0]?.id || "";

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${API_URL}/experiments?limit=20`);
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.message || "Could not load experiment history.");
      }
      if (
        result?.success !== true ||
        !Array.isArray(result.data) ||
        result.count !== result.data.length
      ) {
        throw new Error("The experiments API returned an invalid response.");
      }
      setHistory(result.data);
    } catch (loadError) {
      setError(
        loadError.message ||
          "Cannot connect to the PulseOps API. Is the backend running?"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const request = setTimeout(() => {
      void loadHistory();
    }, 0);
    return () => clearTimeout(request);
  }, [loadHistory, revision]);

  const activeExperiment = useMemo(
    () => history.find((experiment) => ACTIVE_STATES.has(experiment.status)),
    [history]
  );
  const selectedService = services.find(
    (service) => service.id === effectiveServiceId
  );
  const elapsed = elapsedSeconds(activeExperiment, clock);

  useEffect(() => {
    if (activeExperiment?.status !== "running") return undefined;
    const interval = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [activeExperiment?.id, activeExperiment?.status]);

  async function startExperiment() {
    setSubmitting(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`${API_URL}/experiments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceId: effectiveServiceId, durationSeconds })
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.message || "Could not start the experiment.");
      }
      if (result?.success !== true || !result.data?.id) {
        throw new Error("The experiments API returned an invalid response.");
      }
      setNotice("Simulated failure experiment started.");
      await loadHistory();
    } catch (startError) {
      setError(
        startError.message ||
          "Cannot connect to the PulseOps API. Is the backend running?"
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelExperiment() {
    if (!activeExperiment) return;
    setSubmitting(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `${API_URL}/experiments/${encodeURIComponent(activeExperiment.id)}/cancel`,
        { method: "POST" }
      );
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.message || "Could not cancel the experiment.");
      }
      setNotice("Experiment cancelled and service recovery requested.");
      await loadHistory();
    } catch (cancelError) {
      setError(
        cancelError.message ||
          "Cannot connect to the PulseOps API. Is the backend running?"
      );
    } finally {
      setSubmitting(false);
    }
  }

  const canStart =
    selectedService?.status === "healthy" &&
    !activeExperiment &&
    !submitting &&
    !loading;

  return (
    <section className="section experiments-page" aria-labelledby="experiments-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">CONTROLLED SIMULATION</p>
          <h2 id="experiments-title">Simulated Service Failure</h2>
          <p>
            Temporarily degrades a PulseOps simulator service, creates an
            incident, and then recovers it.
          </p>
        </div>
        <span className="source-badge">Simulation only</span>
      </div>

      {notice && (
        <div className="notice" role="status">
          {notice}
          <button type="button" onClick={() => setNotice("")}>Dismiss</button>
        </div>
      )}

      {error && (
        <div className="error-banner experiment-error" role="alert">
          <span>{error}</span>
          <button
            className="secondary-button"
            type="button"
            onClick={loadHistory}
            disabled={loading}
          >
            Refresh
          </button>
        </div>
      )}

      <div className="experiment-config-grid">
        <article className="experiment-config-card">
          <p className="eyebrow">CONFIGURATION REVIEW</p>
          <label>
            Monitored service
            <select
              aria-label="Select service for simulated failure experiment"
              value={effectiveServiceId}
              onChange={(event) => setSelectedServiceId(event.target.value)}
              disabled={loading || submitting || Boolean(activeExperiment)}
            >
              {services.length === 0 ? (
                <option value="">No services available</option>
              ) : (
                services.map((service) => (
                  <option key={service.id} value={service.id}>
                    {service.name}
                  </option>
                ))
              )}
            </select>
          </label>
          <label>
            Duration
            <select
              aria-label="Select simulated failure duration"
              value={durationSeconds}
              onChange={(event) => setDurationSeconds(Number(event.target.value))}
              disabled={loading || submitting || Boolean(activeExperiment)}
            >
              {DURATIONS.map((duration) => (
                <option key={duration} value={duration}>
                  {duration} seconds
                </option>
              ))}
            </select>
          </label>
          <div className="experiment-review">
            <span>Experiment</span>
            <strong>Simulated service failure</strong>
            <span>Service</span>
            <strong>{selectedService?.name || "Loading services…"}</strong>
            <span>Automatic recovery after</span>
            <strong>{durationSeconds} seconds</strong>
          </div>
          <button
            className="danger-button experiment-start"
            type="button"
            onClick={startExperiment}
            disabled={!canStart}
          >
            {submitting ? "Working…" : "Start simulated experiment"}
          </button>
          {selectedService && selectedService.status !== "healthy" && (
            <p className="experiment-hint" role="status">
              Select a healthy service before starting an experiment.
            </p>
          )}
        </article>

        <article className="experiment-config-card experiment-current">
          <p className="eyebrow">CURRENT EXECUTION</p>
          {loading && history.length === 0 ? (
            <p className="empty-state" role="status">
              Loading current experiment…
            </p>
          ) : activeExperiment ? (
            <>
              <div className="experiment-current-heading">
                <h3>
                  {services.find(
                    (service) => service.id === activeExperiment.serviceId
                  )?.name || activeExperiment.serviceId}
                </h3>
                <span className={`experiment-state ${activeExperiment.status}`}>
                  {activeExperiment.status}
                </span>
              </div>
              <p>
                Simulated failure · {activeExperiment.durationSeconds} seconds
              </p>
              {activeExperiment.status === "running" ? (
                <div className="experiment-progress" aria-live="polite">
                  <strong>{elapsed}s</strong>
                  <span>
                    elapsed · {Math.max(0, activeExperiment.durationSeconds - elapsed)}s
                    remaining
                  </span>
                </div>
              ) : (
                <p className="experiment-hint">
                  The experiment is being prepared.
                </p>
              )}
              <button
                className="secondary-button experiment-cancel"
                type="button"
                onClick={cancelExperiment}
                disabled={submitting || activeExperiment.status !== "running"}
              >
                Cancel and recover service
              </button>
            </>
          ) : (
            <div className="empty-state current-empty">
              No experiment is currently running.
            </div>
          )}
        </article>
      </div>

      <section className="section experiment-history">
        <div className="section-heading">
          <div>
            <h2>Recent Experiments</h2>
            <p>Latest recorded experiment states and outcomes.</p>
          </div>
          <button
            className="secondary-button"
            type="button"
            onClick={loadHistory}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "↻ Refresh"}
          </button>
        </div>

        {loading && history.length === 0 ? (
          <p className="empty-state" role="status">Loading experiment history…</p>
        ) : history.length === 0 ? (
          <p className="empty-state">
            No experiments have been recorded. Review a configuration above to
            begin a controlled simulator experiment.
          </p>
        ) : (
          <div className="experiment-history-list">
            {history.map((experiment) => (
              <article className="experiment-history-card" key={experiment.id}>
                <div className="experiment-history-heading">
                  <div>
                    <h3>
                      {services.find(
                        (service) => service.id === experiment.serviceId
                      )?.name || experiment.serviceId}
                    </h3>
                    <p>Simulated service failure · {experiment.durationSeconds}s</p>
                  </div>
                  <span className={`experiment-state ${experiment.status}`}>
                    {experiment.status}
                  </span>
                </div>
                <div className="experiment-history-meta">
                  <span>Started {formatTimestamp(experiment.startedAt)}</span>
                  <span>Ended {formatTimestamp(experiment.completedAt)}</span>
                </div>
                <p className="experiment-outcome">
                  {experiment.outcome || "Experiment is in progress."}
                </p>
              </article>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}

export default Experiments;
