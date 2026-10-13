import { createServer } from "node:http";

const HOST = "127.0.0.1";
const PORT = 5055;
let statusCode = 200;

const server = createServer((request, response) => {
  if (request.socket.remoteAddress !== HOST) {
    response.writeHead(403).end();
    return;
  }

  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(statusCode, { "content-type": "application/json" });
    response.end(JSON.stringify({
      status: statusCode === 200 ? "healthy" : "unhealthy",
      httpStatus: statusCode
    }));
    return;
  }

  if (request.method === "POST" && request.url === "/__mode") {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 128) request.destroy();
    });
    request.on("end", () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (![200, 503].includes(payload.statusCode)) {
        response.writeHead(400).end();
        return;
      }
      statusCode = payload.statusCode;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ statusCode }));
    });
    return;
  }

  response.writeHead(404).end();
});

server.listen(PORT, HOST, () => {
  console.log(`Local PulseOps probe endpoint listening on http://${HOST}:${PORT}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
