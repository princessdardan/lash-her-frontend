import "server-only";
import { timingSafeEqual } from "node:crypto";
import { createAccountLifecycleClient } from "@/lib/api-integration/account-lifecycle-client";
import { mintLifecycleServiceToken } from "@/lib/api-integration/lifecycle-service-jwt";
import { resolveApplicationEnvironment, VERCEL_PROJECT_BINDINGS } from "@/lib/env/application-environment.mjs";
import { currentWriterOperationIdentity } from "@/lib/writer-admission/context";
import { runAccountWriter } from "./context";
import { createAccountLifecycleStore } from "./store";
import { processAccountLifecycle } from "./worker";
import { traceLifecycleCronAdmission } from "./native-trace";
import { AccountLifecycleError } from "./policy";

const OPERATION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const EXPIRE_EXPORT_SELECTOR = /^\?operation=expire-export&commandId=([a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/u;

async function runProductionLifecycleRecovery(onAdmitted?: (operationId: string) => void) {
  return runAccountWriter("recovery", () => {
    const identity = currentWriterOperationIdentity();
    if (identity?.kind === "recovery" && OPERATION_ID.test(identity.operationId)) onAdmitted?.(identity.operationId);
    traceLifecycleCronAdmission();
    return processAccountLifecycle({
    store: createAccountLifecycleStore(),
    client: receiver => createAccountLifecycleClient({ receiver, mintServiceToken: () => mintLifecycleServiceToken(receiver),
      // The whole awaited claim/delivery/settlement/export operation already
      // owns admission. Unknown service effects mark that same parent entry.
      run: async (_kind, task) => task(),
    }),
    });
  });
}

export function createScopedExportCleanupRunner(dependencies: {
  expireExport?: (commandId: string) => ReturnType<ReturnType<typeof createAccountLifecycleStore>["expireExport"]>;
  trace?: () => void;
} = {}) {
  return async (commandId: string, onAdmitted?: (operationId: string) => void) => runAccountWriter("recovery", () => {
    const identity = currentWriterOperationIdentity();
    if (identity?.kind !== "recovery" || !OPERATION_ID.test(identity.operationId)) throw new Error("SCOPED_EXPORT_CLEANUP_REQUIRES_RECOVERY_ADMISSION");
    onAdmitted?.(identity.operationId);
    (dependencies.trace ?? traceLifecycleCronAdmission)();
    return (dependencies.expireExport ?? (selected => createAccountLifecycleStore().expireExport(selected)))(commandId);
  });
}
const runProductionScopedExportCleanup = createScopedExportCleanupRunner();

function isDedicatedStagingProductionRuntime(env: Record<string, string | undefined>): boolean {
  return resolveApplicationEnvironment(env) === "staging" && env.VERCEL === "1" && env.APP_ENV === "staging" &&
    env.VERCEL_ENV === "production" && env.VERCEL_TARGET_ENV === "production" &&
    env.VERCEL_PROJECT_ID === VERCEL_PROJECT_BINDINGS.stagingProjectId;
}

export function createAccountLifecycleCron(dependencies: {
  enabled?: () => boolean;
  secret?: () => string | undefined;
  run?: typeof runProductionLifecycleRecovery;
  runScoped?: typeof runProductionScopedExportCleanup;
  environment?: () => Record<string, string | undefined>;
} = {}) {
  return async (request: Request): Promise<Response> => {
    const headers = { "cache-control": "private, no-store", "retry-after": "30" };
    if (!(dependencies.enabled ?? (() => process.env.CUSTOMER_ACCOUNT_LIFECYCLE_RECOVERY_ENABLED === "true"))()) return Response.json({ error: "unavailable" }, { status: 404, headers });
    const secret = (dependencies.secret ?? (() => process.env.CRON_SECRET?.trim()))();
    if (!secret) return Response.json({ error: "unavailable" }, { status: 404, headers });
    const actual = Buffer.from(request.headers.get("authorization") ?? ""), expected = Buffer.from(`Bearer ${secret}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return Response.json({ error: "unauthorized" }, { status: 401, headers });
    const url = new URL(request.url);
    const scopedMatch = EXPIRE_EXPORT_SELECTOR.exec(url.search);
    if (url.search && !scopedMatch) return Response.json({ error: "unavailable" }, { status: 404, headers });
    if (scopedMatch) {
      if (request.method !== "GET") return Response.json({ error: "unavailable" }, { status: 404, headers });
      try {
        if (!isDedicatedStagingProductionRuntime((dependencies.environment ?? (() => process.env))())) {
          return Response.json({ error: "unavailable" }, { status: 404, headers });
        }
      } catch { return Response.json({ error: "unavailable" }, { status: 404, headers }); }
    }
    let admittedOperationId: string | undefined;
    const captureAdmittedOperation = (operationId: string) => {
      const identity = currentWriterOperationIdentity();
      if (admittedOperationId === undefined && identity?.kind === "recovery" && identity.operationId === operationId &&
        OPERATION_ID.test(operationId)) admittedOperationId = operationId;
    };
    const responseHeaders = () => admittedOperationId === undefined ? headers : { ...headers, "x-request-id": admittedOperationId };
    try {
      if (scopedMatch) {
        const result = await (dependencies.runScoped ?? runProductionScopedExportCleanup)(scopedMatch[1], captureAdmittedOperation);
        if (admittedOperationId === undefined) throw new Error("SCOPED_EXPORT_CLEANUP_ADMISSION_RECEIPT_MISSING");
        return Response.json({ ...result, requestId: admittedOperationId }, { status: 200, headers: responseHeaders() });
      }
      const result = await (dependencies.run ?? runProductionLifecycleRecovery)(captureAdmittedOperation);
      return Response.json(result, { status: result.retrying || result.blocked ? 503 : 200, headers: responseHeaders() });
    } catch (error) {
      if (scopedMatch && error instanceof AccountLifecycleError) return Response.json({ error: error.code }, { status: error.status, headers: responseHeaders() });
      return Response.json({ error: "temporarily_unavailable" }, { status: 503, headers: responseHeaders() });
    }
  };
}
