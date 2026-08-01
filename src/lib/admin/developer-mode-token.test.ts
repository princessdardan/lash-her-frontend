import assert from "node:assert/strict";
import test from "node:test";

import {
  createAdminDeveloperToken,
  verifyAdminDeveloperToken,
} from "./developer-mode-token";

const NOW = 1_787_000_000_000;
const SECRET = "developer-token-secret-with-more-than-32-characters";

test("admin developer tokens verify only for the expected key, purpose, and lifetime", () => {
  const token = createAdminDeveloperToken({
    expiresAt: NOW + 60_000,
    purpose: "session",
    secret: SECRET,
    value: "represented-user.owner",
  });

  assert.equal(
    verifyAdminDeveloperToken({
      now: NOW,
      purpose: "session",
      secret: SECRET,
      token,
    }),
    "represented-user.owner",
  );
  assert.equal(
    verifyAdminDeveloperToken({
      now: NOW,
      purpose: "access",
      secret: SECRET,
      token,
    }),
    null,
  );
  assert.equal(
    verifyAdminDeveloperToken({
      now: NOW,
      purpose: "session",
      secret: `${SECRET}-rotated`,
      token,
    }),
    null,
  );
  assert.equal(
    verifyAdminDeveloperToken({
      now: NOW + 60_000,
      purpose: "session",
      secret: SECRET,
      token,
    }),
    null,
  );
});

test("admin developer tokens reject payload and signature tampering", () => {
  const token = createAdminDeveloperToken({
    expiresAt: NOW + 60_000,
    purpose: "session",
    secret: SECRET,
    value: "represented-user.employee",
  });
  const [payload, signature] = token.split(".");

  for (const tamperedToken of [
    `${payload}x.${signature}`,
    `${payload}.${signature}x`,
    `${token}.extra`,
    "not-a-token",
    "x".repeat(2_049),
  ]) {
    assert.equal(
      verifyAdminDeveloperToken({
        now: NOW,
        purpose: "session",
        secret: SECRET,
        token: tamperedToken,
      }),
      null,
    );
  }
});
