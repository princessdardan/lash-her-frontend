import { request } from "node:https";
import { checkServerIdentity } from "node:tls";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { validateConfig } from "./policy.mjs";

function statusProbe(spec) {
  return new Promise((resolve, reject) => {
    const url = new URL(spec.origin);
    const req = request({
      hostname: spec.loopback ? "127.0.0.1" : url.hostname,
      port: spec.loopback ? 8443 : url.port || 443,
      servername: url.hostname,
      checkServerIdentity: (_hostname, certificate) => checkServerIdentity(url.hostname, certificate),
      rejectUnauthorized: true, minVersion: "TLSv1.2",
      ...(spec.ca ? { ca: spec.ca } : {}),
      method: spec.method ?? "GET", path: spec.path,
      headers: { host: url.host, connection: "close" },
      signal: AbortSignal.timeout(4000),
    }, (res) => {
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 32_768) res.destroy(new Error("Probe response exceeds bound"));
      });
      res.once("end", () => resolve(res.statusCode));
      res.once("error", reject);
    });
    req.once("error", reject);
    req.end();
  });
}

// Read-only positive private-TLS and negative public/auth/peer checks. This is
// not a Vercel-issued workload proof or external IPv4/IPv6 acceptance test.
export async function checkRuntime(input, options = {}) {
  const config = validateConfig(input);
  const ca = options.ca ?? readFileSync(config.upstreamCaFile);
  const check = options.request ?? statusProbe;
  const publicOrigin = `https://${config.publicHost}`;
  const specs = [
    { name: "public-tls-missing-workload-denied", origin: publicOrigin, loopback: true, path: "/course/v1/courses", expected: 401 },
    { name: "public-metrics-hidden", origin: publicOrigin, loopback: true, path: "/course/metrics", expected: 404 },
    { name: "private-course-tls-catalog", origin: config.courseOrigin, ca, path: "/v1/courses", expected: 200 },
    { name: "private-application-credential-required", origin: config.courseOrigin, ca, method: "POST", path: "/v1/internal/entitlements/grants", expected: 401 },
    { name: "private-community-peer-denied", origin: "https://community-tls:8443", ca, method: "POST", path: "/v1/internal/course/enrollment-events", expected: 403 },
  ];
  const checks = [];
  for (const spec of specs) {
    if (await check(spec) !== spec.expected) throw new Error("Runtime boundary probe failed");
    checks.push(spec.name);
  }
  return { status: "API_RUNTIME_BOUNDARIES_PASS", checks, realVercelOidcVerified: false, externalIngressVerified: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = JSON.parse(readFileSync("/config/gateway.json", "utf8"));
    process.stdout.write(JSON.stringify(await checkRuntime(config)) + "\n");
  } catch {
    process.stderr.write("Runtime boundary probe refused\n"); process.exitCode = 1;
  }
}
