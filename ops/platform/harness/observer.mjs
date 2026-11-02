import { createServer } from "node:http";

createServer(async (request, response) => {
  if (request.url !== "/status") { response.writeHead(404); response.end(); return; }
  try {
    const [receiver, worker] = await Promise.all([
      fetch("https://community-tls:8443/metrics", { signal: AbortSignal.timeout(3000) }).then((response) => response.text()),
      fetch("http://community-worker:4101/metrics", { signal: AbortSignal.timeout(3000) }).then((response) => response.text()),
    ]);
    const applied = receiver.split("\n").filter((line) => line.startsWith("community_enrollment_events_total{") && line.includes('outcome="applied"'))
      .reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(" ") + 1)), 0);
    const iteration = Number(worker.match(/^community_worker_last_successful_iteration_timestamp_seconds ([0-9.e+]+)$/mu)?.[1] ?? 0);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ applied, workerAge: Math.floor(Date.now() / 1000 - iteration) }));
  } catch { response.writeHead(503); response.end(); }
}).listen(8080, "0.0.0.0");
