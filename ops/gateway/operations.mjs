import { createServer } from "node:http";

export function createOperationsServer(counters, gauges = {}, admissionState) {
  return createServer({ maxHeaderSize: 4096, requestTimeout: 2000 }, (req, res) => {
    res.setHeader("cache-control", "no-store");
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" }); res.end('{"status":"ok"}');
    } else if (req.method === "GET" && req.url === "/admission" && admissionState) {
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(admissionState()));
    } else if (req.method === "GET" && req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end([
        ...Object.entries(counters).map(([name, value]) => `lash_gateway_${name}_total ${value}`),
        ...Object.entries(gauges).map(([name, value]) => `lash_gateway_${name} ${value}`),
      ].join("\n") + "\n");
    } else { res.writeHead(404); res.end(); }
  });
}
