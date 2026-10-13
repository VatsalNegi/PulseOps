import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";
import { isPublicAddress } from "../config/healthEndpoints.js";

function isAllowedLoopback(endpoint, allowLocalHttp) {
  return (
    allowLocalHttp &&
    endpoint.local &&
    ["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname)
  );
}

async function resolveAllowedAddress(endpoint, allowLocalHttp) {
  if (isAllowedLoopback(endpoint, allowLocalHttp)) {
    return endpoint.hostname === "localhost"
      ? { address: "127.0.0.1", family: 4 }
      : {
          address: endpoint.hostname,
          family: isIP(endpoint.hostname)
        };
  }

  const records = isIP(endpoint.hostname)
    ? [{ address: endpoint.hostname, family: isIP(endpoint.hostname) }]
    : await lookup(endpoint.hostname, { all: true, verbatim: true });
  if (!records.length || records.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("unsafe_endpoint");
  }
  return records[0];
}

function performRequest(endpoint, address, timeoutMs) {
  const url = new URL(endpoint.url);
  const client = url.protocol === "https:" ? httpsRequest : httpRequest;
  const startedAt = performance.now();

  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    let timeout;
    const request = client(
      url,
      {
        method: "GET",
        agent: false,
        headers: { accept: "application/json, text/plain, */*" },
        lookup: (_hostname, _options, callback) => {
          callback(null, address.address, address.family);
        }
      },
      (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const latencyMs = Math.max(0, performance.now() - startedAt);
        const statusCode = response.statusCode ?? null;
        const healthy = statusCode >= 200 && statusCode < 300;
        response.destroy();
        resolve({
          outcome: healthy ? "success" : "unhealthy_http_response",
          failureCategory: healthy ? null : "unhealthy_http_response",
          latencyMs,
          httpStatusCode: statusCode
        });
      }
    );

    timeout = setTimeout(() => {
      timedOut = true;
      request.destroy(new Error("probe_timeout"));
    }, timeoutMs);
    timeout.unref?.();
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        outcome: timedOut ? "timeout" : "connection_error",
        failureCategory: timedOut ? "timeout" : "connection_error",
        latencyMs: null,
        httpStatusCode: null,
        errorName: error.name || "Error"
      });
    });
    request.end();
  });
}

function withDnsTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("probe_timeout")), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export async function probeHttpEndpoint({
  endpoint,
  timeoutMs,
  allowLocalHttp = false,
  measuredAt = new Date()
}) {
  if (!endpoint) {
    return {
      outcome: "unconfigured",
      failureCategory: "unconfigured",
      latencyMs: null,
      httpStatusCode: null,
      measuredAt
    };
  }

  try {
    const address = await withDnsTimeout(
      resolveAllowedAddress(endpoint, allowLocalHttp),
      timeoutMs
    );
    const result = await performRequest(endpoint, address, timeoutMs);
    return { ...result, measuredAt };
  } catch (error) {
    if (error.message === "probe_timeout") {
      return {
        outcome: "timeout",
        failureCategory: "timeout",
        latencyMs: null,
        httpStatusCode: null,
        measuredAt
      };
    }
    const unsafe = error.message === "unsafe_endpoint";
    return {
      outcome: unsafe ? "unsafe_endpoint" : "connection_error",
      failureCategory: unsafe ? "unsafe_endpoint" : "connection_error",
      latencyMs: null,
      httpStatusCode: null,
      measuredAt,
      errorName: error.name || "Error"
    };
  }
}
