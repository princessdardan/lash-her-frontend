import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMarketingUnsubscribeUrl,
  createMarketingUnsubscribeTokenCodec,
  getMarketingUnsubscribeSiteOrigin,
  getMarketingUnsubscribeTokenKeyRing,
  type MarketingUnsubscribeTokenKeyRing,
  verifyMarketingUnsubscribeToken,
} from "./unsubscribe-token";

const ROOT_KEY = Buffer.alloc(32, 17);
const PREVIOUS_KEY = Buffer.alloc(32, 23);
const CURRENT_KEY = Buffer.alloc(32, 29);
const NOW = new Date("2026-08-31T18:30:00.000Z");

function codec(
  audience = { dataset: "production", environment: "production" },
  keyRing: MarketingUnsubscribeTokenKeyRing | null = null,
) {
  return createMarketingUnsubscribeTokenCodec({
    getAudience: () => audience,
    getKeyRing: () => keyRing,
    getRootKey: () => ROOT_KEY,
    now: () => NOW,
  });
}

function ring(
  currentKeyId: string,
  keys: Array<{ id: string; rootKey: Buffer }>,
): MarketingUnsubscribeTokenKeyRing {
  return { currentKeyId, keys };
}

test("unsubscribe token round-trips a normalized email without exposing it", () => {
  const subject = codec();
  const token = subject.createToken({
    email: "  Client@Example.COM ",
    issuedAt: NOW,
  });

  assert.match(token, /^v1\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){3}$/);
  assert.equal(token.includes("client@example.com"), false);
  assert.equal(
    token.includes(Buffer.from("client@example.com").toString("base64url")),
    false,
  );
  assert.deepEqual(subject.verifyToken(token), {
    email: "client@example.com",
    issuedAt: NOW,
    tokenVersion: "v1",
  });
});

test("unsubscribe token rejects tampering and malformed or oversized input", () => {
  const subject = codec();
  const token = subject.createToken({ email: "client@example.com" });
  const replacement = token.endsWith("A") ? "B" : "A";

  assert.equal(
    subject.verifyToken(`${token.slice(0, -1)}${replacement}`),
    null,
  );
  assert.equal(subject.verifyToken(`${token}.extra`), null);
  assert.equal(subject.verifyToken("v1.not+base64.tag.cipher.signature"), null);
  assert.equal(subject.verifyToken("x".repeat(2_049)), null);
});

test("keyed unsubscribe tokens preserve privacy, tamper resistance, and audience binding", () => {
  const keyRing = ring("2026-08", [{ id: "2026-08", rootKey: CURRENT_KEY }]);
  const subject = codec(
    { dataset: "production", environment: "production" },
    keyRing,
  );
  const token = subject.createToken({
    email: " Client@Example.COM ",
    issuedAt: NOW,
  });

  assert.match(token, /^v2\.2026-08\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){3}$/);
  assert.equal(token.includes("client@example.com"), false);
  assert.equal(
    token.includes(Buffer.from("client@example.com").toString("base64url")),
    false,
  );
  assert.deepEqual(subject.verifyToken(token), {
    email: "client@example.com",
    issuedAt: NOW,
    tokenVersion: "v2",
  });

  const replacement = token.endsWith("A") ? "B" : "A";
  assert.equal(
    subject.verifyToken(`${token.slice(0, -1)}${replacement}`),
    null,
  );
  assert.equal(
    codec(
      { dataset: "staging", environment: "production" },
      keyRing,
    ).verifyToken(token),
    null,
  );
});

test("key rotation issues with the current key and verifies retained previous keys", () => {
  const previousCodec = codec(
    undefined,
    ring("2026-01", [{ id: "2026-01", rootKey: PREVIOUS_KEY }]),
  );
  const previousToken = previousCodec.createToken({
    email: "client@example.com",
    issuedAt: NOW,
  });
  const legacyToken = codec().createToken({
    email: "legacy@example.com",
    issuedAt: NOW,
  });
  const rotatedCodec = codec(
    undefined,
    ring("2026-08", [
      { id: "2026-08", rootKey: CURRENT_KEY },
      { id: "2026-01", rootKey: PREVIOUS_KEY },
    ]),
  );
  const currentToken = rotatedCodec.createToken({
    email: "current@example.com",
    issuedAt: NOW,
  });

  assert.match(previousToken, /^v2\.2026-01\./);
  assert.match(currentToken, /^v2\.2026-08\./);
  assert.equal(
    rotatedCodec.verifyToken(previousToken)?.email,
    "client@example.com",
  );
  assert.equal(
    rotatedCodec.verifyToken(currentToken)?.email,
    "current@example.com",
  );
  assert.equal(
    rotatedCodec.verifyToken(legacyToken)?.email,
    "legacy@example.com",
  );
});

test("verification remains compatible with an already-issued v1 token", () => {
  const issuedByPreviousImplementation =
    "v1.BwcHBwcHBwcHBwcH.YC6wbv9kQFoC8sq_0pPm-w.kmdLgp56g5HE47i7843TlkJlzRSV_LwkMZBhW-xYdBjvRS6ct69Zc0ItZ8RxEy0FRcVmuRLYkcwl4gLt9gVRpk5Utvi_vmxPTQ8nIMdmxOocv1v45WyoKXx_beHUWFppVI8rGU0WMqOfUwc_77yRRRBM.1qzU3AC64pdNTgIiXT33U5JJCk4H2FT0zFkvcpoLdrI";
  const verifier = codec(
    undefined,
    ring("2026-08", [{ id: "2026-08", rootKey: CURRENT_KEY }]),
  );

  assert.deepEqual(verifier.verifyToken(issuedByPreviousImplementation), {
    email: "legacy@example.com",
    issuedAt: NOW,
    tokenVersion: "v1",
  });
});

test("keyed unsubscribe tokens reject unknown key IDs", () => {
  const token = codec(
    undefined,
    ring("removed", [{ id: "removed", rootKey: PREVIOUS_KEY }]),
  ).createToken({ email: "client@example.com" });
  const verifier = codec(
    undefined,
    ring("current", [{ id: "current", rootKey: CURRENT_KEY }]),
  );

  assert.equal(verifier.verifyToken(token), null);
});

test("unsubscribe key-ring env parsing is strict and supports a legacy fallback", () => {
  const previousEncoded = PREVIOUS_KEY.toString("base64");
  const currentEncoded = CURRENT_KEY.toString("base64");

  assert.equal(getMarketingUnsubscribeTokenKeyRing({}), null);
  assert.deepEqual(
    getMarketingUnsubscribeTokenKeyRing({
      MARKETING_UNSUBSCRIBE_CURRENT_KEY_ID: "2026-08",
      MARKETING_UNSUBSCRIBE_KEYS: `2026-08:${currentEncoded},2026-01:${previousEncoded}`,
    }),
    ring("2026-08", [
      { id: "2026-08", rootKey: CURRENT_KEY },
      { id: "2026-01", rootKey: PREVIOUS_KEY },
    ]),
  );

  const malformedEnvironments: Array<Record<string, string | undefined>> = [
    { MARKETING_UNSUBSCRIBE_CURRENT_KEY_ID: "2026-08" },
    { MARKETING_UNSUBSCRIBE_KEYS: `2026-08:${currentEncoded}` },
    {
      MARKETING_UNSUBSCRIBE_CURRENT_KEY_ID: "invalid.key",
      MARKETING_UNSUBSCRIBE_KEYS: `invalid.key:${currentEncoded}`,
    },
    {
      MARKETING_UNSUBSCRIBE_CURRENT_KEY_ID: "2026-08",
      MARKETING_UNSUBSCRIBE_KEYS: "",
    },
    {
      MARKETING_UNSUBSCRIBE_CURRENT_KEY_ID: "2026-08",
      MARKETING_UNSUBSCRIBE_KEYS: `2026-08:${Buffer.alloc(31).toString("base64")}`,
    },
    {
      MARKETING_UNSUBSCRIBE_CURRENT_KEY_ID: "2026-08",
      MARKETING_UNSUBSCRIBE_KEYS: `2026-08:${currentEncoded},2026-08:${previousEncoded}`,
    },
    {
      MARKETING_UNSUBSCRIBE_CURRENT_KEY_ID: "missing",
      MARKETING_UNSUBSCRIBE_KEYS: `2026-08:${currentEncoded}`,
    },
    {
      MARKETING_UNSUBSCRIBE_CURRENT_KEY_ID: "2026-08",
      MARKETING_UNSUBSCRIBE_KEYS: `2026-08:${currentEncoded}, 2026-01:${previousEncoded}`,
    },
    {
      MARKETING_UNSUBSCRIBE_CURRENT_KEY_ID: "2026-08",
      MARKETING_UNSUBSCRIBE_KEYS: "x".repeat(4_097),
    },
  ];
  for (const environment of malformedEnvironments) {
    assert.throws(() => getMarketingUnsubscribeTokenKeyRing(environment));
  }
});

test("unsubscribe token is audience-bound", () => {
  const token = codec({
    dataset: "production",
    environment: "production",
  }).createToken({ email: "client@example.com" });

  assert.equal(
    codec({ dataset: "staging", environment: "production" }).verifyToken(token),
    null,
  );
  assert.equal(
    codec({ dataset: "production", environment: "preview" }).verifyToken(token),
    null,
  );
});

test("unsubscribe token rejects future issuance but intentionally does not expire", () => {
  const subject = codec();
  const future = subject.createToken({
    email: "client@example.com",
    issuedAt: new Date(NOW.getTime() + 1_000),
  });
  const old = subject.createToken({
    email: "client@example.com",
    issuedAt: new Date("2000-01-01T00:00:00.000Z"),
  });

  assert.equal(subject.verifyToken(future), null);
  assert.deepEqual(subject.verifyToken(old), {
    email: "client@example.com",
    issuedAt: new Date("2000-01-01T00:00:00.000Z"),
    tokenVersion: "v1",
  });
});

test("unsubscribe token validates email and audience bounds", () => {
  const subject = codec();
  const maxLengthEmail = `${"a".repeat(308)}@example.com`;

  assert.equal(maxLengthEmail.length, 320);
  assert.equal(
    subject.verifyToken(subject.createToken({ email: maxLengthEmail }))?.email,
    maxLengthEmail,
  );
  assert.throws(
    () => subject.createToken({ email: `${"a".repeat(309)}@example.com` }),
    /valid marketing unsubscribe email/,
  );
  assert.throws(
    () => subject.createToken({ email: "not-an-email" }),
    /valid marketing unsubscribe email/,
  );
  assert.throws(
    () =>
      codec({
        dataset: "x".repeat(101),
        environment: "production",
      }).createToken({ email: "client@example.com" }),
    /audience is invalid/,
  );
});

test("unsubscribe site origin requires a canonical secure deployed origin", () => {
  assert.equal(
    getMarketingUnsubscribeSiteOrigin({
      NEXT_PUBLIC_SITE_URL: "https://www.lashher.ca/",
      NODE_ENV: "production",
    }),
    "https://www.lashher.ca",
  );
  assert.equal(
    getMarketingUnsubscribeSiteOrigin({
      NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
      NODE_ENV: "development",
    }),
    "http://localhost:3000",
  );
  assert.equal(
    getMarketingUnsubscribeSiteOrigin({
      NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:3000",
      NODE_ENV: "test",
    }),
    "http://127.0.0.1:3000",
  );

  for (const environment of [
    {
      NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
      NODE_ENV: "production",
    },
    {
      NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
      NODE_ENV: "development",
      VERCEL_ENV: "preview",
    },
    {
      NEXT_PUBLIC_SITE_URL: "http://example.com",
      NODE_ENV: "development",
    },
    {
      NEXT_PUBLIC_SITE_URL: "https://example.com/path",
      NODE_ENV: "production",
    },
    {
      NEXT_PUBLIC_SITE_URL: "https://user@example.com",
      NODE_ENV: "production",
    },
    {
      NODE_ENV: "production",
    },
  ] as NodeJS.ProcessEnv[]) {
    assert.throws(() => getMarketingUnsubscribeSiteOrigin(environment));
  }
});

test("unsubscribe URL builder emits the canonical signed route", () => {
  const previous = {
    checkoutKey: process.env.CHECKOUT_SECRET_ENCRYPTION_KEY,
    dataset: process.env.NEXT_PUBLIC_SANITY_DATASET,
    unsubscribeCurrentKeyId: process.env.MARKETING_UNSUBSCRIBE_CURRENT_KEY_ID,
    unsubscribeKeys: process.env.MARKETING_UNSUBSCRIBE_KEYS,
    nodeEnv: process.env.NODE_ENV,
    siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
    vercelEnv: process.env.VERCEL_ENV,
  };

  process.env.CHECKOUT_SECRET_ENCRYPTION_KEY = ROOT_KEY.toString("base64");
  process.env.NEXT_PUBLIC_SANITY_DATASET = "test-dataset";
  delete process.env.MARKETING_UNSUBSCRIBE_CURRENT_KEY_ID;
  delete process.env.MARKETING_UNSUBSCRIBE_KEYS;
  setEnv("NODE_ENV", "development");
  process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3000";
  delete process.env.VERCEL_ENV;

  try {
    const value = buildMarketingUnsubscribeUrl({
      email: " Client@Example.COM ",
      issuedAt: NOW,
    });
    const url = new URL(value);

    assert.equal(url.origin, "http://localhost:3000");
    assert.equal(url.pathname, "/api/marketing/unsubscribe");
    const token = url.searchParams.get("token");
    assert.ok(token);
    assert.deepEqual(verifyMarketingUnsubscribeToken(token, { now: NOW }), {
      email: "client@example.com",
      issuedAt: NOW,
      tokenVersion: "v1",
    });
  } finally {
    restoreEnv("CHECKOUT_SECRET_ENCRYPTION_KEY", previous.checkoutKey);
    restoreEnv("NEXT_PUBLIC_SANITY_DATASET", previous.dataset);
    restoreEnv(
      "MARKETING_UNSUBSCRIBE_CURRENT_KEY_ID",
      previous.unsubscribeCurrentKeyId,
    );
    restoreEnv("MARKETING_UNSUBSCRIBE_KEYS", previous.unsubscribeKeys);
    restoreEnv("NODE_ENV", previous.nodeEnv);
    restoreEnv("NEXT_PUBLIC_SITE_URL", previous.siteUrl);
    restoreEnv("VERCEL_ENV", previous.vercelEnv);
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function setEnv(name: string, value: string): void {
  process.env[name] = value;
}
