import "server-only";

import { courseApiConfigError } from "./errors";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_USER_TOKEN_TTL_SECONDS = 300;
const DEFAULT_SERVICE_TOKEN_TTL_SECONDS = 300;

export type CourseApiEnvReader = (name: string) => string | undefined;

export interface DisabledCourseApiConfig {
  enabled: false;
}

export interface EnabledCourseApiConfig {
  enabled: true;
  baseUrl: string;
  timeoutMs: number;
  userJwt: {
    secret: string;
    issuer: string;
    audience: string;
    ttlSeconds: number;
  };
  serviceJwt: {
    secret: string;
    issuer: string;
    audience: string;
    subject: string;
    ttlSeconds: number;
  };
}

export type CourseApiConfig = DisabledCourseApiConfig | EnabledCourseApiConfig;

export function readCourseApiConfig(
  readEnv: CourseApiEnvReader = (name) => process.env[name],
): CourseApiConfig {
  const enabled = readBoolean(
    readEnv("ACADEMY_ENABLED"),
    "ACADEMY_ENABLED",
    false,
  );

  if (!enabled) {
    return { enabled: false };
  }

  const baseUrl = readBaseUrl(required(readEnv, "COURSE_API_BASE_URL"));
  const userSecret = readSecret(readEnv, "COURSE_API_USER_JWT_SECRET");
  const serviceSecret = readSecret(readEnv, "COURSE_API_SERVICE_JWT_SECRET");
  const authSecret = readEnv("AUTH_SECRET");

  if (userSecret === serviceSecret) {
    throw courseApiConfigError(
      "Course API user and service JWT secrets must be distinct",
    );
  }
  if (
    authSecret !== undefined &&
    (userSecret === authSecret || serviceSecret === authSecret)
  ) {
    throw courseApiConfigError(
      "Course API JWT secrets must be distinct from AUTH_SECRET",
    );
  }

  return {
    enabled: true,
    baseUrl,
    timeoutMs: readInteger(
      readEnv("COURSE_API_TIMEOUT_MS"),
      "COURSE_API_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS,
      100,
      30_000,
    ),
    userJwt: {
      secret: userSecret,
      issuer: required(readEnv, "COURSE_API_USER_JWT_ISSUER"),
      audience: required(readEnv, "COURSE_API_USER_JWT_AUDIENCE"),
      ttlSeconds: readInteger(
        readEnv("COURSE_API_USER_JWT_TTL_SECONDS"),
        "COURSE_API_USER_JWT_TTL_SECONDS",
        DEFAULT_USER_TOKEN_TTL_SECONDS,
        60,
        3_600,
      ),
    },
    serviceJwt: {
      secret: serviceSecret,
      issuer: required(readEnv, "COURSE_API_SERVICE_JWT_ISSUER"),
      audience: required(readEnv, "COURSE_API_SERVICE_JWT_AUDIENCE"),
      subject: required(readEnv, "COURSE_API_SERVICE_JWT_SUBJECT"),
      ttlSeconds: readInteger(
        readEnv("COURSE_API_SERVICE_JWT_TTL_SECONDS"),
        "COURSE_API_SERVICE_JWT_TTL_SECONDS",
        DEFAULT_SERVICE_TOKEN_TTL_SECONDS,
        60,
        3_600,
      ),
    },
  };
}

export function requireEnabledCourseApiConfig(
  config: CourseApiConfig,
): EnabledCourseApiConfig {
  if (!config.enabled) {
    throw courseApiConfigError("Academy integration is disabled");
  }

  return config;
}

function required(readEnv: CourseApiEnvReader, name: string): string {
  const value = readEnv(name);
  if (value === undefined || value.trim().length === 0) {
    throw courseApiConfigError(`${name} is required when ACADEMY_ENABLED=true`);
  }
  if (value !== value.trim()) {
    throw courseApiConfigError(
      `${name} must not contain surrounding whitespace`,
    );
  }
  return value;
}

function readSecret(readEnv: CourseApiEnvReader, name: string): string {
  const value = required(readEnv, name);
  if (value.length < 32) {
    throw courseApiConfigError(`${name} must contain at least 32 characters`);
  }
  return value;
}

function readBoolean(
  value: string | undefined,
  name: string,
  defaultValue: boolean,
): boolean {
  if (value === undefined) return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw courseApiConfigError(`${name} must be exactly true or false`);
}

function readInteger(
  value: string | undefined,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return defaultValue;
  if (!/^[0-9]+$/u.test(value)) {
    throw courseApiConfigError(`${name} must be an integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw courseApiConfigError(
      `${name} must be between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

function readBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw courseApiConfigError(
      "COURSE_API_BASE_URL must be an absolute HTTP(S) URL",
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw courseApiConfigError("COURSE_API_BASE_URL must use HTTP or HTTPS");
  }
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw courseApiConfigError(
      "COURSE_API_BASE_URL must not contain credentials, a query, or a fragment",
    );
  }
  if (url.protocol !== "https:" && !isLocalhost(url.hostname)) {
    throw courseApiConfigError(
      "COURSE_API_BASE_URL must use HTTPS outside localhost",
    );
  }

  return url.toString().replace(/\/$/u, "");
}

function isLocalhost(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}
