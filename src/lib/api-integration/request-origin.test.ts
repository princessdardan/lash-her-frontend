import assert from "node:assert/strict";
import test from "node:test";
import { hasConfiguredRequestOrigin } from "./request-origin";
import { readSameOriginJson } from "./same-origin-json";

test("origin binding permits only exact origins or explicit non-production loopback normalization", () => {
  const request = (url: string, host?: string) => new Request(url, { headers: host ? { host } : {} });
  assert.equal(hasConfiguredRequestOrigin(request("https://site.example.invalid/a", "site.example.invalid"), "https://site.example.invalid", "production"), true);
  assert.equal(hasConfiguredRequestOrigin(request("http://localhost:3111/a", "127.0.0.1:3111"), "http://127.0.0.1:3111", "development"), true);
  for (const [url, host, configured, environment] of [
    ["http://localhost:3111/a", "127.0.0.1:3111", "http://127.0.0.1:3111", "production"],
    ["http://localhost:3111/a", undefined, "http://127.0.0.1:3111", "development"],
    ["http://localhost:3112/a", "127.0.0.1:3111", "http://127.0.0.1:3111", "development"],
    ["http://evil.invalid:3111/a", "127.0.0.1:3111", "http://127.0.0.1:3111", "development"],
    ["https://site.example.invalid/a", "evil.invalid", "https://site.example.invalid", "production"],
    ["https://site.example.invalid/a", "site.example.invalid", "https://site.example.invalid/path", "production"],
  ] as const) assert.equal(hasConfiguredRequestOrigin(request(url, host), configured, environment), false);
});
test("loopback compatibility preserves exact Origin, CSRF, Fetch Metadata and body bounds", async () => {
  const request = (headers: Record<string, string> = {}) => new Request("http://localhost:3111/api/academy/progress", { method: "POST", headers: { host: "127.0.0.1:3111", origin: "http://127.0.0.1:3111", "content-type": "application/json", "x-lash-csrf": "1", ...headers }, body: "{}" });
  assert.deepEqual(await readSameOriginJson(request(), "http://127.0.0.1:3111"), {});
  const denied: Array<Record<string, string>> = [{ origin: "http://localhost:3111" }, { "x-lash-csrf": "" }, { "sec-fetch-site": "cross-site" }, { host: "evil.invalid" }];
  for (const headers of denied) await assert.rejects(readSameOriginJson(request(headers), "http://127.0.0.1:3111"), { code: "forbidden" });
});
