import "server-only";

import { resolveApplicationEnvironment } from "@/lib/env/application-environment.mjs";

import { runWriterAdmissionWithParent } from "./action";
import { WriterAdmissionError } from "./config";
import {
  runWriterAdmission,
  type WriterAdmissionRunner,
  type WriterOperationKind,
} from "./runtime";

const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
const localOptions = new Set(["sslmode", "application_name", "connect_timeout", "uselibpqcompat"]);

// Reject a direct remote writer before admission can take its off-mode path.
export function assertManualWriterTarget(env: Readonly<Record<string, string | undefined>> = process.env): void {
  const mode = env.FRONTEND_WRITER_ADMISSION_MODE;
  // The runner verifies the enforced release's exact database and role.
  if (mode === "enforce") return;
  try {
    if ((mode !== undefined && mode !== "off") || resolveApplicationEnvironment(env) !== "local" ||
      (env.PRIVATE_DB_MIGRATION_TARGET !== undefined && env.PRIVATE_DB_MIGRATION_TARGET !== "local")) {
      throw new Error();
    }
    const url = new URL(env.DATABASE_URL ?? "");
    if ((url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
      !localHosts.has(url.hostname.toLowerCase()) || !url.pathname || url.pathname === "/" || url.hash ||
      [...url.searchParams.keys()].some(key => !localOptions.has(key))) {
      throw new Error();
    }
  } catch {
    throw new WriterAdmissionError("configuration");
  }
}

// The dry-run callback must remain read-only. Write-mode admission precedes
// even the inventory/provider reads used to decide which writes to perform.
export async function runManualWriterAdmission<T>(
  execute: boolean,
  kind: WriterOperationKind,
  task: () => Promise<T>,
  run: WriterAdmissionRunner = runWriterAdmission,
): Promise<T> {
  if (!execute) return task();
  assertManualWriterTarget();
  return runWriterAdmissionWithParent(kind, task, run);
}
