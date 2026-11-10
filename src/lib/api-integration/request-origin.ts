import "server-only";

/** Next dev normalizes an IPv4 loopback listener to localhost internally. Only
 * that non-production alias may differ from the explicitly configured origin;
 * the external Host must still match. Never trust forwarded origin headers. */
export function hasConfiguredRequestOrigin(request: Pick<Request, "url" | "headers">, configured: string | undefined, environment = process.env.NODE_ENV): boolean {
  try {
    const expected = new URL(configured ?? ""), actual = new URL(request.url);
    if (expected.username || expected.password || expected.pathname !== "/" || expected.search || expected.hash) return false;
    const host = request.headers.get("host");
    if (host && host !== expected.host) return false;
    if (expected.origin === actual.origin) return true;
    const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
    return environment !== "production" && expected.protocol === "http:" && actual.protocol === "http:" && expected.port === actual.port
      && loopback.has(expected.hostname) && loopback.has(actual.hostname) && host === expected.host;
  } catch { return false; }
}
