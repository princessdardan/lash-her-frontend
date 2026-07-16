import assert from "node:assert/strict";
import test from "node:test";

import { readBoundedJsonBody } from "./bounded-json-body";

test("bounded JSON reader parses bodies within the byte limit", async () => {
  const result = await readBoundedJsonBody(new Request("https://example.test", {
    body: JSON.stringify({ ok: true }),
    method: "POST",
  }), 100);
  assert.deepEqual(result, { ok: true, value: { ok: true } });
});

test("bounded JSON reader rejects declared and streamed oversized bodies", async () => {
  assert.deepEqual(await readBoundedJsonBody(new Request("https://example.test", {
    body: "{}",
    headers: { "content-length": "101" },
    method: "POST",
  }), 100), { ok: false, reason: "too_large" });
  assert.deepEqual(await readBoundedJsonBody(new Request("https://example.test", {
    body: JSON.stringify({ value: "x".repeat(100) }),
    method: "POST",
  }), 50), { ok: false, reason: "too_large" });
});
