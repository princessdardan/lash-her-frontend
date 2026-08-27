import assert from "node:assert/strict";
import test from "node:test";

import { readBoundedTextBody } from "./bounded-text-body";

test("bounded text reader returns the raw body within the byte limit", async () => {
  const raw = JSON.stringify({ event_id: "evt_1", type: "payment.updated" });
  const result = await readBoundedTextBody(
    new Request("https://example.test", { body: raw, method: "POST" }),
    64_000,
  );
  assert.deepEqual(result, { ok: true, value: raw });
});

test("bounded text reader does not parse the body", async () => {
  // A raw-text reader must hand back invalid JSON verbatim so the caller can
  // verify a signature over the exact bytes before choosing to parse.
  const raw = "{ not json";
  const result = await readBoundedTextBody(
    new Request("https://example.test", { body: raw, method: "POST" }),
    64_000,
  );
  assert.deepEqual(result, { ok: true, value: raw });
});

test("bounded text reader resolves an absent body to an empty string", async () => {
  const result = await readBoundedTextBody(
    new Request("https://example.test", { method: "POST" }),
    64_000,
  );
  assert.deepEqual(result, { ok: true, value: "" });
});

test("bounded text reader rejects a declared-oversized body without buffering", async () => {
  const result = await readBoundedTextBody(
    new Request("https://example.test", {
      body: "{}",
      headers: { "content-length": "101" },
      method: "POST",
    }),
    100,
  );
  assert.deepEqual(result, { ok: false, reason: "too_large" });
});

test("bounded text reader rejects a streamed body past the limit", async () => {
  const result = await readBoundedTextBody(
    new Request("https://example.test", {
      body: JSON.stringify({ value: "x".repeat(100) }),
      method: "POST",
    }),
    50,
  );
  assert.deepEqual(result, { ok: false, reason: "too_large" });
});

test("bounded text reader rejects a non-positive limit", async () => {
  await assert.rejects(
    readBoundedTextBody(
      new Request("https://example.test", { body: "{}", method: "POST" }),
      0,
    ),
    /Invalid raw body limit/,
  );
});
