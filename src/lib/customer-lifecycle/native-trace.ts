import "server-only";
import { VERCEL_PROJECT_BINDINGS, resolveApplicationEnvironment } from "@/lib/env/application-environment.mjs";
import { currentWriterOperationIdentity } from "@/lib/writer-admission/context";

/** A native request's own provider log can join this opaque ID to the ledger.
 * It is diagnostic evidence only, never authentication or release authority. */
export function traceLifecycleCronAdmission(
  env: Record<string, string | undefined> = process.env,
  emit: (line: string) => void = line => console.info(line),
): void {
  const identity = currentWriterOperationIdentity();
  if (!identity || identity.kind !== "recovery" || env.LASH_P2_CERTIFICATION_SCHEDULES !== "account-lifecycle" ||
    env.VERCEL_ENV !== "production" || env.VERCEL_PROJECT_ID !== VERCEL_PROJECT_BINDINGS.stagingProjectId ||
    env.VERCEL_GIT_COMMIT_SHA !== identity.sourceCommit) return;
  try { if (resolveApplicationEnvironment(env) !== "staging") return; } catch { return; }
  try {
    emit(JSON.stringify({ version: 1, status: "P2_LIFECYCLE_CRON_ADMITTED", environment: "staging",
      projectId: VERCEL_PROJECT_BINDINGS.stagingProjectId, ...identity }));
  } catch { /* A missing diagnostic cannot establish native qualification. */ }
}
