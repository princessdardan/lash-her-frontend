import { timingSafeEqual } from "node:crypto";

import { readCourseApiConfig } from "@/lib/course-api/config";
import { runCourseEntitlementBatch } from "@/lib/course-commerce/dispatch";
import type { EntitlementWorkerRunSummary } from "@/lib/course-commerce/entitlement-worker";
import { log } from "@/lib/logging/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CourseEntitlementCronConfig {
  enabled: boolean;
  primarySecret: string | null;
  secondarySecret: string | null;
}

interface CourseEntitlementCronDependencies {
  getConfig: () => CourseEntitlementCronConfig;
  log: typeof log;
  runBatch: () => Promise<EntitlementWorkerRunSummary>;
}

const defaultDependencies: CourseEntitlementCronDependencies = {
  getConfig: getCourseEntitlementCronConfig,
  log,
  runBatch: runCourseEntitlementBatch,
};

export const GET = createCourseEntitlementCronHandler(defaultDependencies);

export function createCourseEntitlementCronHandler(
  dependencies: CourseEntitlementCronDependencies,
): (request: Request) => Promise<Response> {
  return async function courseEntitlementCronHandler(request) {
    const config = dependencies.getConfig();

    if (!config.enabled || config.primarySecret === null) {
      return new Response(null, { status: 404 });
    }

    if (!isAuthorized(request, config)) {
      return new Response(null, { status: 401 });
    }

    try {
      const summary = await dependencies.runBatch();
      dependencies.log("info", "Course entitlement cron completed", {
        ...summary,
      });
      return Response.json(summary);
    } catch (error) {
      dependencies.log("error", "Course entitlement cron failed", {
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      return Response.json(
        { error: "Course entitlement delivery failed" },
        { status: 503 },
      );
    }
  };
}

export function getCourseEntitlementCronConfig(): CourseEntitlementCronConfig {
  try {
    const courseApiConfig = readCourseApiConfig();
    const enabled =
      process.env.COURSE_ENTITLEMENT_WORKER_ENABLED === "true" &&
      courseApiConfig.enabled;
    const primarySecret = readStrongSecret("COURSE_ENTITLEMENT_CRON_SECRET");
    const secondarySecret =
      primarySecret === null ? null : readSecret("CRON_SECRET");

    if (
      primarySecret !== null &&
      (primarySecret === secondarySecret ||
        primarySecret === process.env.AUTH_SECRET ||
        (courseApiConfig.enabled &&
          (primarySecret === courseApiConfig.userJwt.secret ||
            primarySecret === courseApiConfig.serviceJwt.secret)))
    ) {
      throw new Error("Course entitlement cron secret must be distinct");
    }

    return {
      enabled,
      primarySecret,
      // CRON_SECRET never enables this route by itself.
      secondarySecret,
    };
  } catch {
    return { enabled: false, primarySecret: null, secondarySecret: null };
  }
}

function isAuthorized(
  request: Request,
  config: CourseEntitlementCronConfig,
): boolean {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }

  const candidate = authorization.slice("Bearer ".length);
  return [config.primarySecret, config.secondarySecret].some(
    (secret) => secret !== null && secretsEqual(candidate, secret),
  );
}

function secretsEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function readSecret(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value.trim().length === 0 ? null : value;
}

function readStrongSecret(name: string): string | null {
  const value = readSecret(name);
  if (value === null) return null;
  if (value !== value.trim() || value.length < 32) {
    throw new Error(`${name} must contain at least 32 characters`);
  }
  return value;
}
