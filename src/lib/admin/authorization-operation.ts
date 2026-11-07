import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { runWriterAdmissionWithParent } from "@/lib/writer-admission/action";
import { runWriterAdmission, type WriterAdmissionRunner } from "@/lib/writer-admission/runtime";
import { AdminAuthError, type AdminActor } from "./types";

interface AdminAuthorizationContext {
  actor?: Promise<AdminActor>;
}
const context = new AsyncLocalStorage<AdminAuthorizationContext>();

// Only callers sharing this admitted authorization operation may reuse an
// actor. Request headers cannot identify or join another operation's cache.
export function getAdminAuthorizationActor(resolve: () => Promise<AdminActor>): Promise<AdminActor> {
  const operation = context.getStore();
  if (!operation) throw new Error("ADMIN_AUTHORIZATION_OPERATION_REQUIRED");
  return operation.actor ??= Promise.resolve().then(resolve);
}

// Actor resolution can bind or refresh a persistent identity. Keep its reads,
// writes, resource lookup and denial audit inside one admission operation,
// including calls made while rendering the protected admin layout. An existing
// generic writer context does not qualify this operation.
export async function runAdminAuthorizationOperation<T>(
  work: () => Promise<T>,
  run: WriterAdmissionRunner = runWriterAdmission,
): Promise<T> {
  if (context.getStore()) return work();
  // Existing identity refresh and already-authorized callbacks remain eligible
  // recovery. First binding/bootstrap keeps its independent new-work gate.
  const outcome = await runWriterAdmissionWithParent("recovery", () => context.run({}, async () => {
    try { return { ok: true as const, value: await work() }; }
    catch (error) {
      // A confirmed authorization denial settles before a page redirects.
      // Caught persistence/audit uncertainty is still enforced by the runner.
      if (error instanceof AdminAuthError) return { ok: false as const, error };
      throw error;
    }
  }), run);
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
