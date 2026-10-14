
const http = require("node:http");

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200);
    return res.end(JSON.stringify({
      status: "healthy",
      service: "pulseops-probe"
    }));
  }

  if (req.method === "GET" && req.url === "/unhealthy") {
    res.writeHead(503);
    return res.end(JSON.stringify({
      status: "unhealthy"
    }));
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(process.env.PORT || 10000, "0.0.0.0");
