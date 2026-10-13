import { Router } from "express";
import { DEFAULT_SERVICES } from "../config/services.js";
import Metric from "../models/Metric.js";
import HttpError from "../utils/HttpError.js";

const router = Router();
const supportedServiceIds = new Set(
  DEFAULT_SERVICES.map((service) => service.id)
);
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const allowedQueryParameters = new Set([
  "serviceId",
  "from",
  "to",
  "limit",
  "source"
]);
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function parseMetricQuery(query) {
  for (const key of Object.keys(query)) {
    if (!allowedQueryParameters.has(key)) {
      throw new HttpError(400, `Unsupported query parameter: ${key}`);
    }
    if (Array.isArray(query[key])) {
      throw new HttpError(400, `Query parameter ${key} must be provided once`);
    }
  }

  const source = query.source ?? "simulated";
  if (!["simulated", "http_probe"].includes(source)) {
    throw new HttpError(400, "Invalid metric source");
  }

  if (query.serviceId !== undefined) {
    if (
      typeof query.serviceId !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(query.serviceId)
    ) {
      throw new HttpError(400, "Invalid service ID");
    }
    if (!supportedServiceIds.has(query.serviceId)) {
      throw new HttpError(404, "Service not found");
    }
  }

  let from;
  let to;
  for (const [parameter, value] of [
    ["from", query.from],
    ["to", query.to]
  ]) {
    if (value === undefined) continue;
    if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) {
      throw new HttpError(400, `Invalid ${parameter} timestamp`);
    }
    const [year, month, day] = value
      .slice(0, 10)
      .split("-")
      .map(Number);
    const daysInMonth = [
      31,
      year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
      31,
      30,
      31,
      30,
      31,
      31,
      30,
      31,
      30,
      31
    ][month - 1];
    if (!daysInMonth || day < 1 || day > daysInMonth) {
      throw new HttpError(400, `Invalid ${parameter} timestamp`);
    }
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) {
      throw new HttpError(400, `Invalid ${parameter} timestamp`);
    }
    if (parameter === "from") from = parsed;
    else to = parsed;
  }

  if (from && to && from >= to) {
    throw new HttpError(400, "The from timestamp must be before to");
  }

  let limit = DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    if (!/^\d+$/.test(query.limit)) {
      throw new HttpError(400, "Limit must be a positive whole number");
    }
    limit = Number(query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new HttpError(
        400,
        `Limit must be between 1 and ${MAX_LIMIT}`
      );
    }
  }

  const filter = {};
  if (query.serviceId) filter.serviceId = query.serviceId;
  filter.source = source;
  if (from || to) {
    filter.measuredAt = {};
    if (from) filter.measuredAt.$gte = from;
    if (to) filter.measuredAt.$lte = to;
  }

  return { filter, limit };
}

function serializeMetric(metric) {
  return {
    id: metric._id,
    serviceId: metric.serviceId,
    timestamp: metric.measuredAt.toISOString(),
    latencyMs: metric.latencyMs,
    status: metric.status,
    source: metric.source,
    outcome: metric.outcome,
    httpStatusCode: metric.httpStatusCode ?? null,
    failureCategory: metric.failureCategory ?? null
  };
}

function buildSummaryPipeline(filter) {
  return [
    { $match: filter },
    {
      $facet: {
        totals: [
          { $count: "count" }
        ],
        latency: [
          { $match: { latencyMs: { $ne: null } } },
          {
            $group: {
              _id: null,
              measurementCount: { $sum: 1 },
              averageLatencyMs: { $avg: "$latencyMs" },
              minimumLatencyMs: { $min: "$latencyMs" },
              maximumLatencyMs: { $max: "$latencyMs" }
            }
          }
        ],
        byStatus: [
          { $group: { _id: "$status", count: { $sum: 1 } } },
          { $sort: { _id: 1 } }
        ],
        bySource: [
          { $group: { _id: "$source", count: { $sum: 1 } } },
          { $sort: { _id: 1 } }
        ]
      }
    }
  ];
}

router.get("/", async (req, res) => {
  const { filter, limit } = parseMetricQuery(req.query);
  const [metrics, total] = await Promise.all([
    Metric.find(filter).sort({ measuredAt: -1, _id: -1 }).limit(limit).lean(),
    Metric.countDocuments(filter)
  ]);

  return res.json({
    success: true,
    count: metrics.length,
    total,
    limit,
    data: metrics.map(serializeMetric)
  });
});

router.get("/summary", async (req, res) => {
  if (req.query.limit !== undefined) {
    throw new HttpError(400, "Limit is not supported for metric summaries");
  }
  const { filter } = parseMetricQuery(req.query);
  const [result = { totals: [], latency: [], byStatus: [], bySource: [] }] =
    await Metric.aggregate(buildSummaryPipeline(filter));
  const totals = result.totals[0];
  const latency = result.latency[0];

  return res.json({
    success: true,
    data: {
      count: totals?.count ?? 0,
      measurementCount: latency?.measurementCount ?? 0,
      averageLatencyMs: latency?.averageLatencyMs ?? null,
      minimumLatencyMs: latency?.minimumLatencyMs ?? null,
      maximumLatencyMs: latency?.maximumLatencyMs ?? null,
      byStatus: Object.fromEntries(
        result.byStatus.map(({ _id, count }) => [_id, count])
      ),
      bySource: Object.fromEntries(
        result.bySource.map(({ _id, count }) => [_id, count])
      )
    }
  });
});

export default router;
