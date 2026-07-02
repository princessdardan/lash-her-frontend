import test from "node:test";
import assert from "node:assert/strict";
import { log } from "./logger";

test("log emits parseable JSON with expected fields", () => {
  const originalConsoleLog = console.log;
  const logged: string[] = [];

  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };

  try {
    log("error", "test message", { requestId: "req-123", stage: "init" });

    assert.equal(logged.length, 1, "expected exactly one log line");

    const parsed = JSON.parse(logged[0]);

    assert.equal(parsed.level, "error");
    assert.equal(parsed.message, "test message");
    assert.equal(parsed.service, "lash-her-frontend");
    assert.ok(
      Object.hasOwn(parsed, "environment"),
      "environment should be present as top-level key",
    );
    assert.equal(parsed.environment, process.env.NODE_ENV ?? null);
    assert.equal(parsed.requestId, "req-123");
    assert.equal(parsed.stage, "init");
    assert.ok(
      typeof parsed.timestamp === "string",
      "timestamp should be a string",
    );
    assert.doesNotThrow(
      () => new Date(parsed.timestamp),
      "timestamp should be a valid ISO date",
    );
  } finally {
    console.log = originalConsoleLog;
  }
});

test("log works without meta", () => {
  const originalConsoleLog = console.log;
  const logged: string[] = [];

  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };

  try {
    log("warn", "no meta");

    assert.equal(logged.length, 1);

    const parsed = JSON.parse(logged[0]);

    assert.equal(parsed.level, "warn");
    assert.equal(parsed.message, "no meta");
    assert.equal(parsed.service, "lash-her-frontend");
    assert.equal(parsed.requestId, undefined);
    assert.ok(
      Object.hasOwn(parsed, "environment"),
      "environment should be present as top-level key",
    );
    assert.equal(parsed.environment, process.env.NODE_ENV ?? null);
  } finally {
    console.log = originalConsoleLog;
  }
});

test("log includes environment: null when NODE_ENV is absent", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  delete (process.env as Record<string, string | undefined>).NODE_ENV;

  const originalConsoleLog = console.log;
  const logged: string[] = [];

  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };

  try {
    log("info", "missing node env");

    assert.equal(logged.length, 1);

    const parsed = JSON.parse(logged[0]);

    assert.ok(
      Object.hasOwn(parsed, "environment"),
      "environment should be present as top-level key",
    );
    assert.equal(parsed.environment, null);
  } finally {
    console.log = originalConsoleLog;
    if (originalNodeEnv !== undefined) {
      (process.env as Record<string, string | undefined>).NODE_ENV =
        originalNodeEnv;
    }
  }
});
