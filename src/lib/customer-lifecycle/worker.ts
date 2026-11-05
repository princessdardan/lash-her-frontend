import "server-only";
import { assertAccountWriter } from "./context";
import type { AccountCommand, AccountReceiver } from "./policy";
import type { AccountLifecycleStore } from "./store";

export interface LifecycleClient {
  deliverCommand(command: AccountCommand): Promise<{ commandId: string; accountVersion: number; status: "accepted" | "duplicate" }>;
  getExport(command: AccountCommand): Promise<{ commandId: string; userId: string; accountVersion: number; expiresAt: string; data: unknown }>;
}

/** One bounded, awaited recovery operation. Claims survive process death; an
 * unknown receiver result is retried with the exact durable command and ID. */
export async function processAccountLifecycle(dependencies: { store: AccountLifecycleStore; client: (receiver: AccountReceiver) => LifecycleClient }) {
  assertAccountWriter();
  const deadline = performance.now() + 60_000;
  const result = { acknowledged: 0, retrying: 0, blocked: 0, exportsReady: 0, expired: await dependencies.store.expireExports() };
  for (let index = 0; index < 20; index++) {
    if (performance.now() >= deadline) break;
    const claim = await dependencies.store.claimDelivery();
    if (!claim) break;
    try {
      const receipt = await dependencies.client(claim.receiver).deliverCommand(claim.command);
      if (receipt.commandId !== claim.command.commandId || receipt.accountVersion !== claim.command.accountVersion || !["accepted", "duplicate"].includes(receipt.status)) throw new Error("INVALID_LIFECYCLE_RECEIPT");
      await dependencies.store.settleDelivery(claim, "acknowledged");
      result.acknowledged++;
    } catch (error) {
      const retryable = !(error && typeof error === "object" && "retryable" in error && error.retryable === false);
      // Never persist provider response text, profiles, credentials or exports
      // in generic receipt/error columns.
      await dependencies.store.settleDelivery(claim, retryable ? "retry" : "blocked", retryable ? "receiver_unavailable" : "receiver_rejected");
      result[retryable ? "retrying" : "blocked"]++;
    }
  }
  for (const pending of await dependencies.store.pendingExports()) {
    if (performance.now() >= deadline) break;
    try {
      const course = await dependencies.client("course").getExport(pending.command);
      const community = await dependencies.client("community").getExport(pending.command);
      for (const source of [course, community]) {
        if (source.commandId !== pending.command.commandId || source.userId !== pending.command.userId || source.accountVersion !== pending.command.accountVersion || !Number.isFinite(Date.parse(source.expiresAt))) throw new Error("INVALID_LIFECYCLE_EXPORT");
      }
      await dependencies.store.completeExport(pending.command, { version: 1, commandId: pending.command.commandId, userId: pending.command.userId, frontend: pending.frontendData, course: course.data, community: community.data }, [new Date(course.expiresAt), new Date(community.expiresAt)]);
      result.exportsReady++;
    } catch (error) {
      if (error && typeof error === "object" && "status" in error && (error.status === 404 || error.status === 410)) await dependencies.store.failExport(pending.command.commandId);
      result.retrying++;
    }
  }
  return result;
}
