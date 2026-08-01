import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const adminBoundary = readFileSync(
  new URL("./error.tsx", import.meta.url),
  "utf8",
);
const protectedBoundary = readFileSync(
  new URL("./(protected)/error.tsx", import.meta.url),
  "utf8",
);

test("admin routes have segment error boundaries above and inside the protected shell", () => {
  assert.match(adminBoundary, /^"use client";/);
  assert.match(adminBoundary, /<AdminErrorState/);
  assert.match(adminBoundary, /standalone/);

  assert.match(protectedBoundary, /^"use client";/);
  assert.match(protectedBoundary, /<AdminErrorState/);
  assert.doesNotMatch(protectedBoundary, /standalone/);
});
