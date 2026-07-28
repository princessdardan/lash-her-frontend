"use strict";

/* eslint-disable @typescript-eslint/no-require-imports */
const { createHash, randomUUID } = require("node:crypto");
const {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { join } = require("node:path");

const FIXTURE_FLAG = "BOOKING_ADMIN_E2E_GOOGLE_FIXTURE";
const INSTALLATION_MARKER = Symbol.for(
  "lash-her.google-calendar-fetch-fixture",
);
const FIXTURE_CODE_PREFIX = "e2e-calendar-";
const FIXTURE_ACCESS_TOKEN_PREFIX = "e2e-calendar-access-";
const FIXTURE_REFRESH_TOKEN_PREFIX = "e2e-calendar-refresh-";
const OAUTH_STATE_KEY_PREFIX = "booking:calendar-oauth-state:";
const OAUTH_STATE_DIRECTORY = join(
  process.cwd(),
  "test-results",
  "calendar-oauth-state",
);
const REQUIRED_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
].join(" ");

if (process.env[FIXTURE_FLAG] === "1") {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "The Google Calendar Playwright fixture cannot run in production.",
    );
  }

  installGoogleCalendarFetchFixture();
}

function installGoogleCalendarFetchFixture() {
  if (globalThis[INSTALLATION_MARKER] === true) {
    return;
  }

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== "function") {
    throw new Error("The Google Calendar Playwright fixture requires fetch.");
  }

  globalThis[INSTALLATION_MARKER] = true;
  globalThis.fetch = async function googleCalendarFixtureFetch(input, init) {
    const url = toUrl(input);

    if (
      url.origin === "https://e2e-redis.invalid" &&
      (url.pathname === "/" || url.pathname === "/pipeline") &&
      requestMethod(input, init) === "POST"
    ) {
      const redisResponse = await handleOAuthStateRedisRequest(
        input,
        init,
        url.pathname === "/pipeline",
      );
      if (redisResponse !== null) {
        return redisResponse;
      }
    }

    if (
      url.origin === "https://oauth2.googleapis.com" &&
      url.pathname === "/token" &&
      requestMethod(input, init) === "POST"
    ) {
      const form = new URLSearchParams(await requestBody(input, init));
      const authorizationRunId = fixtureRunId(
        form.get("code"),
        FIXTURE_CODE_PREFIX,
      );
      if (authorizationRunId !== null) {
        return jsonResponse({
          access_token: `${FIXTURE_ACCESS_TOKEN_PREFIX}${authorizationRunId}`,
          expires_in: 3600,
          refresh_token: `${FIXTURE_REFRESH_TOKEN_PREFIX}${authorizationRunId}`,
          scope: REQUIRED_SCOPES,
          token_type: "Bearer",
        });
      }

      const refreshRunId = fixtureRunId(
        form.get("refresh_token"),
        FIXTURE_REFRESH_TOKEN_PREFIX,
      );
      if (refreshRunId !== null) {
        return jsonResponse({
          access_token: `${FIXTURE_ACCESS_TOKEN_PREFIX}${refreshRunId}`,
          expires_in: 3600,
          scope: REQUIRED_SCOPES,
          token_type: "Bearer",
        });
      }
    }

    const accessRunId = fixtureRunId(
      authorizationToken(input, init),
      FIXTURE_ACCESS_TOKEN_PREFIX,
    );

    if (
      accessRunId !== null &&
      url.origin === "https://www.googleapis.com" &&
      url.pathname === "/oauth2/v2/userinfo" &&
      requestMethod(input, init) === "GET"
    ) {
      return jsonResponse({
        email: fixtureEmail(accessRunId),
        id: `fixture-account-${accessRunId}`,
        verified_email: true,
      });
    }

    if (
      accessRunId !== null &&
      url.origin === "https://www.googleapis.com" &&
      url.pathname === "/calendar/v3/users/me/calendarList" &&
      requestMethod(input, init) === "GET"
    ) {
      return jsonResponse({
        items: [
          {
            accessRole: "owner",
            id: `fixture-calendar-${accessRunId}@group.calendar.google.com`,
            primary: false,
            summary: "Browser fixture calendar",
          },
        ],
      });
    }

    if (
      url.origin === "https://oauth2.googleapis.com" &&
      url.pathname === "/revoke" &&
      requestMethod(input, init) === "POST"
    ) {
      const form = new URLSearchParams(await requestBody(input, init));
      if (
        fixtureRunId(form.get("token"), FIXTURE_REFRESH_TOKEN_PREFIX) !== null
      ) {
        return new Response(null, { status: 200 });
      }
    }

    return originalFetch.call(globalThis, input, init);
  };
}

async function handleOAuthStateRedisRequest(input, init, isPipeline) {
  let payload;
  try {
    payload = JSON.parse(await requestBody(input, init));
  } catch {
    return null;
  }
  const commands = isPipeline ? payload : [payload];
  if (!Array.isArray(commands)) {
    return null;
  }

  const results = commands.map(handleOAuthStateRedisCommand);
  if (results.some((result) => result.handled === false)) {
    return null;
  }

  if (isPipeline) {
    return new Response(
      JSON.stringify(results.map((result) => ({ result: result.value }))),
      {
        headers: {
          "content-type": "application/json",
          "upstash-sync-token": "calendar-e2e-sync",
        },
        status: 200,
      },
    );
  }

  return upstashResponse(results[0].value);
}

function handleOAuthStateRedisCommand(command) {
  if (!Array.isArray(command)) {
    return { handled: false };
  }
  const operation = String(command[0] ?? "").toLowerCase();
  if (operation === "set") {
    const key = command[1];
    const value = command[2];
    if (
      typeof key !== "string" ||
      !key.startsWith(OAUTH_STATE_KEY_PREFIX) ||
      typeof value !== "string"
    ) {
      return { handled: false };
    }

    const existing = currentOAuthStateValue(key);
    if (command.includes("nx") && existing !== null) {
      return { handled: true, value: null };
    }
    const exIndex = command.indexOf("ex");
    const ttlSeconds =
      exIndex >= 0 && Number.isFinite(Number(command[exIndex + 1]))
        ? Number(command[exIndex + 1])
        : 600;
    saveOAuthStateValue(key, {
      expiresAt: Date.now() + ttlSeconds * 1000,
      value,
    }, command.includes("nx"));
    return { handled: true, value: "OK" };
  }

  if (operation === "eval") {
    const key = command[3];
    if (
      typeof key !== "string" ||
      !key.startsWith(OAUTH_STATE_KEY_PREFIX)
    ) {
      return { handled: false };
    }

    const stored = currentOAuthStateValue(key);
    deleteOAuthStateValue(key);
    return {
      handled: true,
      value:
        stored === null
          ? null
          : Buffer.from(
              JSON.stringify(stored.value),
              "utf8",
            ).toString("base64"),
    };
  }

  return { handled: false };
}

function currentOAuthStateValue(key) {
  try {
    const stored = JSON.parse(
      readFileSync(oauthStatePath(key), "utf8"),
    );
    if (
      typeof stored?.expiresAt !== "number" ||
      typeof stored?.value !== "string" ||
      stored.expiresAt <= Date.now()
    ) {
      deleteOAuthStateValue(key);
      return null;
    }
    return stored;
  } catch {
    return null;
  }
}

function saveOAuthStateValue(key, stored, onlyIfAbsent) {
  mkdirSync(OAUTH_STATE_DIRECTORY, { mode: 0o700, recursive: true });
  const destination = oauthStatePath(key);
  if (onlyIfAbsent) {
    try {
      writeFileSync(destination, JSON.stringify(stored), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return;
    } catch (error) {
      if (error?.code === "EEXIST") {
        return;
      }
      throw error;
    }
  }

  const temporary = `${destination}.${process.pid}.${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify(stored), {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, destination);
}

function deleteOAuthStateValue(key) {
  try {
    unlinkSync(oauthStatePath(key));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function oauthStatePath(key) {
  return join(
    OAUTH_STATE_DIRECTORY,
    `${createHash("sha256").update(key).digest("hex")}.json`,
  );
}

function authorizationToken(input, init) {
  const headers = new Headers(
    input instanceof Request ? input.headers : init?.headers,
  );
  const authorization = headers.get("authorization");
  return authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : null;
}

function fixtureEmail(runId) {
  return `calendar-${runId}@example.test`;
}

function fixtureRunId(value, prefix) {
  if (
    typeof value !== "string" ||
    !value.startsWith(prefix) ||
    !/^[a-z0-9]+$/i.test(value.slice(prefix.length))
  ) {
    return null;
  }

  return value.slice(prefix.length);
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function upstashResponse(result) {
  return new Response(JSON.stringify({ result }), {
    headers: {
      "content-type": "application/json",
      "upstash-sync-token": "calendar-e2e-sync",
    },
    status: 200,
  });
}

async function requestBody(input, init) {
  if (init?.body instanceof URLSearchParams) {
    return init.body.toString();
  }

  if (typeof init?.body === "string") {
    return init.body;
  }

  if (input instanceof Request) {
    return input.clone().text();
  }

  return "";
}

function requestMethod(input, init) {
  return (
    init?.method ??
    (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
}

function toUrl(input) {
  return new URL(input instanceof Request ? input.url : String(input));
}
