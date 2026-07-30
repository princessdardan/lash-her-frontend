import "server-only";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  adminAuditLogs,
  type AdminAuditMetadata,
} from "@/lib/private-db/schema";

import { recordAdminAuditBestEffort } from "./audit-log";
import { sanitizeAdminAuditMetadata } from "./audit-metadata";
import {
  classifyAdminMutationFailure,
  executeAdminMutationAttempt,
  getCommittedAdminAuditOutcome,
} from "./admin-transaction-policy";
import { executeAuditedMutation } from "./audited-mutation";
import type { AdminActor } from "./types";

type PrivateDb = ReturnType<typeof getPrivateDb>;
export type AdminWriteTransaction = Parameters<
  Parameters<PrivateDb["transaction"]>[0]
>[0];

interface AuditedMutationInput<T> {
  action: string;
  actor: AdminActor;
  domain: string;
  metadata?: AdminAuditMetadata;
  mutate: (tx: AdminWriteTransaction) => Promise<T>;
  targetId: string | ((result: T) => string);
  targetType: string;
}

export async function runAuditedAdminMutation<T>(
  input: AuditedMutationInput<T>,
): Promise<T> {
  const db = getPrivateDb();

  return executeAdminMutationAttempt(
    () =>
      executeAuditedMutation((operation) => db.transaction(operation), {
        mutate: input.mutate,
        writeAudit: async (tx, result) => {
          const targetId =
            typeof input.targetId === "function"
              ? input.targetId(result)
              : input.targetId;

          await tx.insert(adminAuditLogs).values({
            action: input.action,
            actorAdminUserId: input.actor.user.id,
            actorRole: input.actor.user.role,
            domain: input.domain,
            metadata: sanitizeAdminAuditMetadata(input.metadata),
            outcome: getCommittedAdminAuditOutcome(input.action),
            targetId,
            targetType: input.targetType,
          });
        },
      }),
    async (error) => {
      const failure = classifyAdminMutationFailure(error);
      await recordAdminAuditBestEffort({
        action: input.action,
        actor: input.actor,
        domain: input.domain,
        outcome: failure.outcome,
        reason: failure.reason,
        targetId:
          typeof input.targetId === "string" ? input.targetId : undefined,
        targetType: input.targetType,
      });
    },
  );
}
