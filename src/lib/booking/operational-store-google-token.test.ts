import assert from "node:assert/strict";
import test from "node:test";

import {
  readGoogleRefreshToken,
  writeGoogleRefreshToken,
  type GoogleRefreshTokenStorage,
} from "./google-refresh-token-store";

function createTokenStorage(initialValues: Record<string, string> = {}): {
  storage: GoogleRefreshTokenStorage;
  values: Map<string, string>;
} {
  const values = new Map(Object.entries(initialValues));

  return {
    storage: {
      async get<TData>(key: string) {
        return (values.get(key) as TData | undefined) ?? null;
      },
      async set(key: string, value: string) {
        values.set(key, value);
        return "OK";
      },
    },
    values,
  };
}

test("Google refresh tokens are isolated between preview and production", async () => {
  const { storage, values } = createTokenStorage();

  await writeGoogleRefreshToken("production-token", storage, {
    VERCEL_ENV: "production",
  });
  await writeGoogleRefreshToken("preview-token", storage, {
    VERCEL_ENV: "preview",
  });

  assert.equal(
    await readGoogleRefreshToken(storage, { VERCEL_ENV: "production" }),
    "production-token",
  );
  assert.equal(
    await readGoogleRefreshToken(storage, { VERCEL_ENV: "preview" }),
    "preview-token",
  );
  assert.equal(
    values.get("booking:google-refresh-token:production"),
    "production-token",
  );
  assert.equal(
    values.get("booking:google-refresh-token:preview"),
    "preview-token",
  );
});

test("custom Vercel target environments use their own stable namespace", async () => {
  const { storage, values } = createTokenStorage();

  await writeGoogleRefreshToken("staging-token", storage, {
    VERCEL_ENV: "preview",
    VERCEL_TARGET_ENV: "Staging",
  });

  assert.equal(
    values.get("booking:google-refresh-token:staging"),
    "staging-token",
  );
  assert.equal(
    await readGoogleRefreshToken(storage, {
      VERCEL_ENV: "preview",
      VERCEL_TARGET_ENV: "Staging",
    }),
    "staging-token",
  );
});

test("only production falls back to the historical unscoped token", async () => {
  const { storage } = createTokenStorage({
    "booking:google-refresh-token": "legacy-production-token",
  });

  assert.equal(
    await readGoogleRefreshToken(storage, { VERCEL_ENV: "production" }),
    "legacy-production-token",
  );
  assert.equal(
    await readGoogleRefreshToken(storage, { VERCEL_ENV: "preview" }),
    null,
  );
});

test("local development does not use the production legacy token", async () => {
  const { storage, values } = createTokenStorage({
    "booking:google-refresh-token": "legacy-production-token",
  });

  await writeGoogleRefreshToken("local-token", storage, {});

  assert.equal(
    values.get("booking:google-refresh-token:development"),
    "local-token",
  );
  assert.equal(await readGoogleRefreshToken(storage, {}), "local-token");
});
