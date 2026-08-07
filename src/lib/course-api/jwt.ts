import "server-only";

import { createHmac, randomUUID } from "node:crypto";

import type { EnabledCourseApiConfig } from "./config";
import { courseApiConfigError } from "./errors";

export interface JwtRuntime {
  nowSeconds?: () => number;
  createJti?: () => string;
}

export function createCourseUserToken(
  config: EnabledCourseApiConfig["userJwt"],
  userId: string,
  runtime: JwtRuntime = {},
): string {
  return signToken(config, userId, runtime);
}

export function createCourseServiceToken(
  config: EnabledCourseApiConfig["serviceJwt"],
  runtime: JwtRuntime = {},
): string {
  return signToken(config, config.subject, runtime);
}

function signToken(
  config: {
    secret: string;
    issuer: string;
    audience: string;
    ttlSeconds: number;
  },
  subject: string,
  runtime: JwtRuntime,
): string {
  if (subject.length === 0) {
    throw courseApiConfigError("Course API JWT subject must not be empty");
  }

  const now = Math.floor((runtime.nowSeconds ?? (() => Date.now() / 1_000))());
  const jti = (runtime.createJti ?? randomUUID)();
  if (!Number.isSafeInteger(now) || jti.length === 0) {
    throw courseApiConfigError(
      "Course API JWT runtime produced invalid claims",
    );
  }

  const header = encodeJson({ alg: "HS256", typ: "JWT" });
  const payload = encodeJson({
    iss: config.issuer,
    aud: config.audience,
    sub: subject,
    iat: now,
    exp: now + config.ttlSeconds,
    jti,
  });
  const unsignedToken = `${header}.${payload}`;
  const signature = createHmac("sha256", config.secret)
    .update(unsignedToken)
    .digest("base64url");
  return `${unsignedToken}.${signature}`;
}

function encodeJson(value: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
