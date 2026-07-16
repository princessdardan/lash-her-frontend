import "server-only";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  adminAuditLogs,
  type AdminAuditMetadata,
} from "@/lib/private-db/schema";

import { sanitizeAdminAuditMetadata } from "./audit-metadata";
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

  return executeAuditedMutation(
    (operation) => db.transaction(operation),
    {
      mutate: input.mutate,
      writeAudit: async (tx, result) => {
        const targetId = typeof input.targetId === "function"
          ? input.targetId(result)
          : input.targetId;

        await tx.insert(adminAuditLogs).values({
          action: input.action,
          actorAdminUserId: input.actor.user.id,
          actorRole: input.actor.user.role,
          domain: input.domain,
          metadata: sanitizeAdminAuditMetadata(input.metadata),
          outcome: "success",
          targetId,
          targetType: input.targetType,
        });
      },
    },
  );
}
