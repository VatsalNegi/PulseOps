import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { API_URL } from "./api.js";

const TIME_RANGES = [
  { label: "15 minutes", value: "15m", durationMs: 15 * 60 * 1000 },
  { label: "1 hour", value: "1h", durationMs: 60 * 60 * 1000 },
  { label: "6 hours", value: "6h", durationMs: 6 * 60 * 60 * 1000 },
  { label: "24 hours", value: "24h", durationMs: 24 * 60 * 60 * 1000 }
];
const HISTORY_LIMIT = 500;

function formatLatency(value, maximumFractionDigits = 1) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toLocaleString(undefined, { maximumFractionDigits })} ms`
    : "—";
}

function formatAxisTime(value, range) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const options =
    range === "24h"
      ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
      : { hour: "2-digit", minute: "2-digit", second: "2-digit" };
  return date.toLocaleString(undefined, options);
}

function formatTooltipTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown timestamp"
    : date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "medium"
      });
}

function isSummaryResponse(result) {
  const summary = result?.data;
  return (
    result?.success === true &&
    summary !== null &&
    typeof summary === "object" &&
    Number.isInteger(summary.count) &&
    summary.count >= 0 &&
    Number.isInteger(summary.measurementCount) &&
    summary.measurementCount >= 0 &&
    summary.measurementCount <= summary.count &&
    ["averageLatencyMs", "minimumLatencyMs", "maximumLatencyMs"].every(
      (field) =>
        summary[field] === null ||
        (typeof summary[field] === "number" &&
          Number.isFinite(summary[field]) &&
          summary[field] >= 0)
    ) &&
    summary.bySource !== null &&
    typeof summary.bySource === "object" &&
    !Array.isArray(summary.bySource) &&
    Object.values(summary.bySource).every(
      (count) => Number.isInteger(count) && count >= 0
    )
  );
}

function normalizeMetrics(result) {
  if (
    result?.success !== true ||
    !Array.isArray(result.data) ||
    !Number.isInteger(result.total) ||
    result.total < 0 ||
    !Number.isInteger(result.count) ||
    result.count < 0 ||
    result.count > HISTORY_LIMIT ||
    result.count !== result.data.length ||
    result.count > result.total ||
    result.limit !== HISTORY_LIMIT
  ) {
    throw new Error("The metrics API returned an invalid response.");
  }

  return result.data
    .filter(
      (metric) =>
        metric &&
        typeof metric.timestamp === "string" &&
        typeof metric.latencyMs === "number" &&
        Number.isFinite(metric.latencyMs) &&
        metric.latencyMs >= 0 &&
        Number.isFinite(Date.parse(metric.timestamp))
    )
    .map((metric) => ({
      ...metric,
      timestampMs: Date.parse(metric.timestamp)
    }))
    .sort((left, right) => left.timestampMs - right.timestampMs);
}

function MetricSummaryCard({ label, value, note }) {
  return (
    <article className="summary-card metric-history-summary">
      <span className="metric-label">{label}</span>
      <strong>{value}</strong>
      <span className="metric-note">{note}</span>
    </article>
  );
}

function HistoricalMetrics({ services, metricEventIds }) {
  const [selectedServiceId, setSelectedServiceId] = useState("");
  const [timeRange, setTimeRange] = useState(TIME_RANGES[1].value);
  const [metrics, setMetrics] = useState([]);
  const [summary, setSummary] = useState(null);
  const [totalSamples, setTotalSamples] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const effectiveServiceId = services.some(
    (service) => service.id === selectedServiceId
  )
    ? selectedServiceId
    : services[0]?.id || "";
  const matchingMetricEventId = metricEventIds[effectiveServiceId] || "";

  const loadMetrics = useCallback(
    async (signal) => {
      const selectedRange = TIME_RANGES.find(
        (range) => range.value === timeRange
      );
      if (!effectiveServiceId || !selectedRange) return;

      const to = new Date();
      const from = new Date(to.getTime() - selectedRange.durationMs);
      const query = new URLSearchParams({
        serviceId: effectiveServiceId,
        source: "http_probe",
        from: from.toISOString(),
        to: to.toISOString(),
        limit: String(HISTORY_LIMIT)
      });
      const summaryQuery = new URLSearchParams({
        serviceId: effectiveServiceId,
        source: "http_probe",
        from: from.toISOString(),
        to: to.toISOString()
      });

      setLoading(true);
      setError("");

      try {
        const [metricsResponse, summaryResponse] = await Promise.all([
          fetch(`${API_URL}/metrics?${query}`, { signal }),
          fetch(`${API_URL}/metrics/summary?${summaryQuery}`, { signal })
        ]);
        const [metricsResult, summaryResult] = await Promise.all([
          metricsResponse.json(),
          summaryResponse.json()
        ]);

        if (!metricsResponse.ok || !summaryResponse.ok) {
          throw new Error(
            metricsResult.message ||
              summaryResult.message ||
              "Could not load historical metrics."
          );
        }
        if (!isSummaryResponse(summaryResult)) {
          throw new Error("The metrics summary API returned an invalid response.");
        }

        const points = normalizeMetrics(metricsResult);
        setMetrics(points);
        setTotalSamples(metricsResult.total);
        setSummary(summaryResult.data);
      } catch (loadError) {
        if (loadError.name === "AbortError") return;
        setMetrics([]);
        setTotalSamples(0);
        setSummary(null);
        setError(
          loadError.message ||
            "Cannot connect to the PulseOps API. Is the backend running?"
        );
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [effectiveServiceId, timeRange]
  );

  useEffect(() => {
    if (!effectiveServiceId) return undefined;
    const controller = new AbortController();
    const request = setTimeout(() => {
      void loadMetrics(controller.signal);
    }, 0);
    return () => {
      clearTimeout(request);
      controller.abort();
    };
  }, [effectiveServiceId, loadMetrics, matchingMetricEventId, refreshKey]);

  const selectedService = services.find(
    (service) => service.id === effectiveServiceId
  );
  const chartData = useMemo(
    () =>
      metrics.map((metric) => ({
        ...metric,
        chartTime: new Date(metric.timestampMs).toISOString()
      })),
    [metrics]
  );

  return (
    <section className="section historical-metrics" aria-labelledby="metrics-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">HISTORICAL TELEMETRY</p>
          <h2 id="metrics-title">Service Metrics</h2>
          <p>Explore recorded real HTTP probe measurements over time.</p>
        </div>
        <span className="source-badge">Real HTTP probe</span>
      </div>

      <div className="metrics-controls">
        <label>
          <span>Service</span>
          <select
            aria-label="Select service for historical metrics"
            value={effectiveServiceId}
            onChange={(event) => setSelectedServiceId(event.target.value)}
            disabled={services.length === 0}
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
          <span>Time range</span>
          <select
            aria-label="Select historical metrics time range"
            value={timeRange}
            onChange={(event) => setTimeRange(event.target.value)}
          >
            {TIME_RANGES.map((range) => (
              <option key={range.value} value={range.value}>
                Last {range.label}
              </option>
            ))}
          </select>
        </label>

        <button
          className="secondary-button metrics-refresh"
          type="button"
          onClick={() => setRefreshKey((key) => key + 1)}
          disabled={loading || !effectiveServiceId}
        >
          {loading ? "Refreshing..." : "↻ Refresh"}
        </button>
      </div>

      {error && (
        <div className="error-banner metrics-error" role="alert">
          <span>{error}</span>
          <button
            className="secondary-button"
            type="button"
            onClick={() => setRefreshKey((key) => key + 1)}
            disabled={loading}
          >
            Try again
          </button>
        </div>
      )}

      {!effectiveServiceId ? (
        <div className="empty-state metrics-state" role="status">
          Load services to view historical metrics.
        </div>
      ) : loading ? (
        <div className="empty-state metrics-state" role="status">
          Loading {selectedService?.name || "service"} metrics…
        </div>
      ) : error ? null : (
        <>
          <div className="metric-history-summary-grid">
            <MetricSummaryCard
              label="AVERAGE LATENCY"
              value={formatLatency(summary?.averageLatencyMs)}
              note="For the selected time range"
            />
            <MetricSummaryCard
              label="MINIMUM LATENCY"
              value={formatLatency(summary?.minimumLatencyMs)}
              note="Lowest recorded sample"
            />
            <MetricSummaryCard
              label="MAXIMUM LATENCY"
              value={formatLatency(summary?.maximumLatencyMs)}
              note="Highest recorded sample"
            />
            <MetricSummaryCard
              label="SAMPLES"
              value={summary?.count.toLocaleString() ?? "—"}
              note="HTTP probe samples in this range"
            />
          </div>

          <article className="chart-panel" aria-label="Latency history chart">
            <div className="chart-heading">
              <div>
                <h3>{selectedService?.name || effectiveServiceId} latency</h3>
                <p>Latency in milliseconds</p>
              </div>
              <span>
                {metrics.length.toLocaleString()} latency points from{" "}
                {totalSamples.toLocaleString()} probe samples
                {totalSamples > HISTORY_LIMIT
                  ? ` (most recent ${HISTORY_LIMIT} samples fetched)`
                  : ""}
              </span>
            </div>
            {totalSamples > metrics.length && (
              <p className="chart-limit-note">
                Summary values use all probe samples in the selected range.
                The chart considers up to the most recent{" "}
                {Math.min(totalSamples, HISTORY_LIMIT)} samples and plots only
                those with a valid latency measurement.
              </p>
            )}

            {summary?.count === 0 ? (
              <div className="empty-state chart-empty">
                No samples recorded for this service in the selected time range.
              </div>
            ) : chartData.length === 0 ? (
              <div className="empty-state chart-empty" role="status">
                {summary?.count
                  ? "Probe samples were recorded, but none contain a valid latency measurement."
                  : "No HTTP probe samples were recorded for this service in the selected time range."}
              </div>
            ) : (
              <div className="latency-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={chartData}
                    margin={{ top: 12, right: 18, bottom: 4, left: 4 }}
                  >
                    <CartesianGrid stroke="#27334a" strokeDasharray="3 5" />
                    <XAxis
                      dataKey="chartTime"
                      tickFormatter={(value) => formatAxisTime(value, timeRange)}
                      tick={{ fill: "#8492ad", fontSize: 10 }}
                      tickLine={false}
                      axisLine={{ stroke: "#34415b" }}
                      minTickGap={32}
                    />
                    <YAxis
                      width={60}
                      tickFormatter={(value) => `${value} ms`}
                      tick={{ fill: "#8492ad", fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip
                      labelFormatter={formatTooltipTime}
                      formatter={(value) => [formatLatency(value), "Latency"]}
                      contentStyle={{
                        background: "#111a2c",
                        border: "1px solid #34415b",
                        borderRadius: 8,
                        color: "#e8edf7"
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="latencyMs"
                      name="Latency"
                      stroke="#7895ff"
                      strokeWidth={2}
                      dot={chartData.length === 1 ? { r: 4 } : false}
                      activeDot={{ r: 5 }}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </article>
        </>
      )}
    </section>
  );
}

export default HistoricalMetrics;
