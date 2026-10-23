import assert from "node:assert/strict";
import test from "node:test";

import {
  assertProviderEnvironment,
  resolveApplicationEnvironment,
  VERCEL_PROJECT_BINDINGS,
} from "./application-environment.mjs";

const bindings = {
  ...VERCEL_PROJECT_BINDINGS,
  stagingProjectId: "prj_staging_test_fixture",
};
const production = {
  VERCEL: "1",
  VERCEL_ENV: "production",
  VERCEL_TARGET_ENV: "production",
  APP_ENV: "production",
  APP_VERCEL_TEAM_ID: bindings.teamId,
  VERCEL_PROJECT_ID: bindings.productionProjectId,
};
const staging = {
  ...production,
  APP_ENV: "staging",
  VERCEL_PROJECT_ID: bindings.stagingProjectId,
};
const preview = {
  ...production,
  APP_ENV: "staging",
  VERCEL_ENV: "preview",
  VERCEL_TARGET_ENV: "preview",
};

test("local builds preserve local configuration without inferring a hosted release", () => {
  assert.equal(
    resolveApplicationEnvironment({ NODE_ENV: "production" }),
    "local",
  );
  assert.equal(resolveApplicationEnvironment({ APP_ENV: "local" }), "local");
  assert.equal(
    resolveApplicationEnvironment({
      VERCEL: "1",
      VERCEL_ENV: "development",
      APP_ENV: "local",
    }),
    "local",
  );
  assert.throws(
    () => resolveApplicationEnvironment({ APP_ENV: "production" }),
    /verified Vercel/,
  );
});

test("distinct projects can use the same Production target with isolated APP_ENV values", () => {
  assert.equal(
    resolveApplicationEnvironment(production, bindings),
    "production",
  );
  assert.equal(resolveApplicationEnvironment(staging, bindings), "staging");
  assert.equal(resolveApplicationEnvironment(preview, bindings), "staging");
});

test("reviewed staging identity works without overriding the recorded bindings", () => {
  const deployedStaging = {
    ...production,
    APP_ENV: "staging",
    VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.stagingProjectId,
  };
  assert.equal(resolveApplicationEnvironment(deployedStaging), "staging");
  assert.throws(
    () => resolveApplicationEnvironment({ ...deployedStaging, APP_ENV: "production" }),
    /project\/target binding/,
  );
  assert.throws(
    () => resolveApplicationEnvironment({ ...production, APP_ENV: "staging" }),
    /project\/target binding/,
  );
});

test("hosted releases require an explicit exact environment and deployment identity", () => {
  for (const APP_ENV of [undefined, "", "local", "Staging", " production "]) {
    assert.throws(
      () => resolveApplicationEnvironment({ ...production, APP_ENV }, bindings),
      /require APP_ENV/,
    );
  }
  for (const key of ["APP_VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"] as const) {
    assert.throws(() =>
      resolveApplicationEnvironment(
        { ...production, [key]: undefined },
        bindings,
      ),
    );
    assert.throws(() =>
      resolveApplicationEnvironment(
        { ...production, [key]: "untrusted" },
        bindings,
      ),
    );
  }
  assert.throws(
    () =>
      resolveApplicationEnvironment(
        { ...production, VERCEL_ENV: undefined },
        bindings,
      ),
    /supported VERCEL_ENV/,
  );
  assert.throws(
    () =>
      resolveApplicationEnvironment(
        { ...production, VERCEL_TARGET_ENV: "Staging" },
        bindings,
      ),
    /VERCEL_TARGET_ENV/,
  );
  assert.throws(
    () =>
      resolveApplicationEnvironment(
        { ...production, VERCEL_TARGET_ENV: undefined },
        bindings,
      ),
    /VERCEL_TARGET_ENV/,
  );
});

test("swapped projects, preview production config and unreviewed projects fail closed", () => {
  assert.throws(
    () =>
      resolveApplicationEnvironment(
        { ...production, APP_ENV: "staging" },
        bindings,
      ),
    /project\/target binding/,
  );
  assert.throws(
    () =>
      resolveApplicationEnvironment(
        { ...staging, APP_ENV: "production" },
        bindings,
      ),
    /project\/target binding/,
  );
  assert.throws(
    () =>
      resolveApplicationEnvironment(
        { ...preview, APP_ENV: "production" },
        bindings,
      ),
    /Preview deployments/,
  );
  assert.throws(
    () =>
      resolveApplicationEnvironment(
        { ...preview, VERCEL_PROJECT_ID: "prj_other" },
        bindings,
      ),
    /Preview deployments/,
  );
});

test("missing staging inventory and identical project bindings cannot authorize a deployment", () => {
  assert.throws(
    () =>
      resolveApplicationEnvironment(staging, {
        ...bindings,
        stagingProjectId: null,
      }),
    /has not been recorded/,
  );
  assert.throws(
    () =>
      resolveApplicationEnvironment(production, {
        ...bindings,
        stagingProjectId: bindings.productionProjectId,
      }),
    /Invalid reviewed/,
  );
});

test("production and preview provider selection rejects cross-environment configuration", () => {
  for (const [name, values] of [
    ["SQUARE_ENVIRONMENT", { production: "production", staging: "sandbox" }],
    ["CHITCHATS_ENVIRONMENT", { production: "production", staging: "staging" }],
    [
      "NEXT_PUBLIC_SANITY_DATASET",
      { production: "production", staging: "staging-2026-05-10" },
    ],
  ] as const) {
    assert.doesNotThrow(() =>
      assertProviderEnvironment(name, values.production, values, production),
    );
    assert.doesNotThrow(() =>
      assertProviderEnvironment(name, values.staging, values, preview),
    );
    assert.throws(
      () => assertProviderEnvironment(name, values.staging, values, production),
      /production deployment requires/,
    );
    assert.throws(
      () => assertProviderEnvironment(name, values.production, values, preview),
      /staging deployment requires/,
    );
  }
});

test("configuration errors never echo untrusted values", () => {
  const secret = "untrusted-value-that-must-not-be-logged";
  assert.throws(
    () => resolveApplicationEnvironment({ ...production, APP_ENV: secret }),
    (error: Error) => !error.message.includes(secret),
  );
  assert.throws(
    () =>
      assertProviderEnvironment(
        "SQUARE_ENVIRONMENT",
        secret,
        { production: "production", staging: "sandbox" },
        production,
      ),
    (error: Error) => !error.message.includes(secret),
  );
});
