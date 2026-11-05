import "server-only";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { customerProviderLinks, customerSessions, customerUsers, customerVerificationTokens } from "@/lib/customer-auth/schema";
import { getPrivateDb } from "@/lib/private-db/client";
import { assertAccountWriter } from "./context";
import { ACCOUNT_RECEIVERS, AccountLifecycleError, assertFreshCustomerSession, EXPORT_MAX_AGE_MS, parseAccountCommand, type AccountAction, type AccountCommand, type AccountReceiver } from "./policy";
import { customerAccountCommands as commands, customerAccountDeliveries as deliveries, customerAccountExports as exports, customerAccountPreferences as preferences } from "./schema";
import type { AccountCustomerSession } from "./session";

type Database = ReturnType<typeof getPrivateDb>;
export type AccountRequester = { kind: "customer"; session: AccountCustomerSession } | { kind: "admin"; adminId: string };
export interface ClaimedAccountDelivery { command: AccountCommand; receiver: AccountReceiver; leaseId: string; attempts: number }

// Scrub receipts prove persisted byte absence without loading up to 100 private
// export payloads into the worker. Ownership/readiness/expiry remain exact.
const exportScrubFields = { commandId: exports.commandId, userId: exports.userId, status: exports.status, readyAt: exports.readyAt, expiresAt: exports.expiresAt,
  dataCleared: sql<boolean>`${exports.data} is null`, frontendCleared: sql<boolean>`${exports.frontendData} is null` };

export function createAccountLifecycleStore(database: () => Database = getPrivateDb, now: () => Date = () => new Date()) {
  return {
    async request(input: { userId: string; action: AccountAction; idempotencyKey: string; requester: AccountRequester }): Promise<AccountCommand> {
      assertAccountWriter();
      return database().transaction(async tx => {
        const [user] = await tx.select().from(customerUsers).where(eq(customerUsers.id, input.userId)).for("update");
        if (!user) throw new AccountLifecycleError(404, "account_unavailable");
        const instant = now();
        if (input.requester.kind === "customer") {
          if (input.requester.session.userId !== user.id || user.status !== "active" || !["export", "delete"].includes(input.action)) throw new AccountLifecycleError(403, "account_action_denied");
          const [session] = await tx.select().from(customerSessions).where(and(eq(customerSessions.tokenHash, input.requester.session.tokenHash), eq(customerSessions.userId, user.id), gt(customerSessions.expires, instant))).for("update");
          if (!session) throw new AccountLifecycleError(401, "sign_in_required");
          assertFreshCustomerSession(session.createdAt, instant);
        }
        const [known] = await tx.select().from(commands).where(and(eq(commands.userId, user.id), eq(commands.idempotencyKey, input.idempotencyKey)));
        if (known) {
          if (known.action !== input.action) throw new AccountLifecycleError(409, "idempotency_conflict");
          return parseAccountCommand(known.command);
        }
        if (user.status === "deleted") throw new AccountLifecycleError(409, "account_deleted");
        if (input.action === "export") {
          const [pending] = await tx.select({ commandId: exports.commandId }).from(exports).where(and(eq(exports.userId, user.id), eq(exports.status, "pending"))).limit(1);
          if (pending) throw new AccountLifecycleError(429, "export_pending");
          const [recent] = await tx.select({ issuedAt: commands.issuedAt }).from(commands).where(and(eq(commands.userId, user.id), eq(commands.action, "export"))).orderBy(desc(commands.accountVersion)).limit(1);
          if (recent && recent.issuedAt.getTime() > instant.getTime() - 900_000) throw new AccountLifecycleError(429, "export_rate_limited");
        }
        if (user.accountVersion >= Number.MAX_SAFE_INTEGER) throw new AccountLifecycleError(409, "account_version_exhausted");
        const command = parseAccountCommand({ version: 1, commandId: randomUUID(), userId: user.id, accountVersion: user.accountVersion + 1, action: input.action, issuedAt: instant.toISOString() });
        const commandRows = await tx.insert(commands).values({ ...command, command, idempotencyKey: input.idempotencyKey, issuedAt: instant, requestedByAdminId: input.requester.kind === "admin" ? input.requester.adminId : null }).returning();
        if (commandRows.length !== 1 || !isDeepStrictEqual(commandRows[0].command, command) || commandRows[0].commandId !== command.commandId || commandRows[0].userId !== user.id || commandRows[0].accountVersion !== command.accountVersion || commandRows[0].action !== command.action || commandRows[0].idempotencyKey !== input.idempotencyKey) throw new Error("ACCOUNT_COMMAND_RECEIPT_MISSING");
        const inserted = await tx.insert(deliveries).values(ACCOUNT_RECEIVERS.map(receiver => ({ commandId: command.commandId, receiver, nextRunAt: instant }))).returning();
        const actual = await tx.select().from(deliveries).where(eq(deliveries.commandId, command.commandId));
        for (const rows of [inserted, actual]) {
          if (rows.length !== 2 || ACCOUNT_RECEIVERS.some(receiver => rows.filter(row => row.commandId === command.commandId && row.receiver === receiver && row.status === "pending" && row.attempts === 0 && row.leaseId === null && row.acknowledgedAt === null).length !== 1)) throw new Error("ACCOUNT_DELIVERY_RECEIPT_MISSING");
        }
        const updated = await tx.update(customerUsers).set({ accountVersion: command.accountVersion,
          ...(input.action === "export" ? {} : { status: input.action === "delete" ? "deleted" : "suspended" }),
          ...(input.action === "delete" ? { email: `deleted+${user.id}@account.invalid`, emailVerified: null, name: null } : {}),
        }).where(eq(customerUsers.id, user.id)).returning();
        if (updated.length !== 1 || updated[0].id !== user.id || updated[0].accountVersion !== command.accountVersion || updated[0].status !== (input.action === "export" ? user.status : input.action === "delete" ? "deleted" : "suspended")) throw new Error("ACCOUNT_STATE_RECEIPT_MISSING");
        if (input.action !== "export") {
          await tx.delete(customerSessions).where(eq(customerSessions.userId, user.id));
          if ((await tx.select({ tokenHash: customerSessions.tokenHash }).from(customerSessions).where(eq(customerSessions.userId, user.id)).limit(1)).length) throw new Error("ACCOUNT_SESSION_REVOCATION_RECEIPT_MISSING");
        }
        if (input.action === "delete") {
          await tx.delete(customerProviderLinks).where(eq(customerProviderLinks.userId, user.id));
          await tx.delete(customerVerificationTokens).where(eq(customerVerificationTokens.identifier, user.email));
          await tx.delete(preferences).where(eq(preferences.userId, user.id));
          await tx.update(exports).set({ frontendData: null, data: null, status: "expired", expiresAt: instant }).where(eq(exports.userId, user.id));
          const remaining = await tx.execute<{ count: number }>(sql`select (
            (select count(*) from customer_provider_links where user_id = ${user.id}::uuid) +
            (select count(*) from customer_verification_tokens where identifier = ${user.email}) +
            (select count(*) from customer_account_preferences where user_id = ${user.id}::uuid) +
            (select count(*) from customer_account_exports where user_id = ${user.id}::uuid and (data is not null or frontend_data is not null))
          )::int as count`);
          if (remaining.rows[0]?.count !== 0) throw new Error("ACCOUNT_DELETION_RECEIPT_MISSING");
          // Existing financial/booking/marketing records have independent
          // retention and no verified immutable customer relationship in P2.
          // Never infer ownership or destructive authority from an email match.
        }
        if (input.action === "export") {
          const links = await tx.select({ provider: customerProviderLinks.provider, linkedAt: customerProviderLinks.createdAt }).from(customerProviderLinks).where(eq(customerProviderLinks.userId, user.id));
          const [savedPreferences] = await tx.select({ learningUpdates: preferences.learningUpdates }).from(preferences).where(eq(preferences.userId, user.id));
          const history = await tx.select({ commandId: commands.commandId, accountVersion: commands.accountVersion, action: commands.action, issuedAt: commands.issuedAt }).from(commands).where(eq(commands.userId, user.id)).orderBy(desc(commands.accountVersion)).limit(100);
          const frontendData = {
            profile: { userId: user.id, email: user.email, name: user.name, emailVerified: user.emailVerified?.toISOString() ?? null, createdAt: user.createdAt.toISOString() },
            signInMethods: links.map(link => ({ provider: link.provider, linkedAt: link.linkedAt.toISOString() })),
            preferences: savedPreferences ?? { learningUpdates: false },
            recentCommands: history.map(row => ({ ...row, issuedAt: row.issuedAt.toISOString() })),
            recentCommandLimit: 100,
            scope: "Records linked to this immutable customer UUID, with up to 100 recent lifecycle commands. Guest financial, booking and marketing records retain their separate verified access and retention processes.",
          };
          const snapshots = await tx.insert(exports).values({ commandId: command.commandId, userId: user.id, frontendData }).returning();
          const actualSnapshots = await tx.select().from(exports).where(eq(exports.commandId, command.commandId));
          for (const rows of [snapshots, actualSnapshots]) if (rows.length !== 1 || rows[0].commandId !== command.commandId || rows[0].userId !== user.id || rows[0].status !== "pending" || rows[0].data !== null || !isDeepStrictEqual(rows[0].frontendData, frontendData)) throw new Error("ACCOUNT_EXPORT_SNAPSHOT_RECEIPT_MISSING");
        }
        const [persistedUser] = await tx.select().from(customerUsers).where(eq(customerUsers.id, user.id));
        if (!persistedUser || !isDeepStrictEqual(persistedUser, updated[0])) throw new Error("ACCOUNT_STATE_RECEIPT_MISSING");
        return command;
      });
    },

    async updatePreferences(session: AccountCustomerSession, learningUpdates: boolean): Promise<void> {
      assertAccountWriter();
      await database().transaction(async tx => {
        const [user] = await tx.select().from(customerUsers).where(eq(customerUsers.id, session.userId)).for("update");
        const [current] = await tx.select().from(customerSessions).where(and(eq(customerSessions.tokenHash, session.tokenHash), eq(customerSessions.userId, session.userId), gt(customerSessions.expires, now())));
        if (user?.status !== "active" || !current) throw new AccountLifecycleError(401, "sign_in_required");
        const rows = await tx.insert(preferences).values({ userId: user.id, learningUpdates, updatedAt: now() }).onConflictDoUpdate({ target: preferences.userId, set: { learningUpdates, updatedAt: now() } }).returning();
        const [persisted] = await tx.select().from(preferences).where(eq(preferences.userId, user.id));
        if (rows.length !== 1 || rows[0].userId !== user.id || rows[0].learningUpdates !== learningUpdates || !persisted || !isDeepStrictEqual(rows[0], persisted)) throw new Error("ACCOUNT_PREFERENCE_RECEIPT_MISSING");
      });
    },

    async overview(userId: string) {
      const [saved] = await database().select({ learningUpdates: preferences.learningUpdates }).from(preferences).where(eq(preferences.userId, userId));
      const rows = await database().select({ commandId: commands.commandId, action: commands.action, accountVersion: commands.accountVersion, issuedAt: commands.issuedAt, exportStatus: exports.status, expiresAt: exports.expiresAt }).from(commands)
        .leftJoin(exports, eq(exports.commandId, commands.commandId)).where(eq(commands.userId, userId)).orderBy(desc(commands.accountVersion)).limit(50);
      return { preferences: saved ?? { learningUpdates: false }, commands: rows };
    },

    async getExport(userId: string, commandId: string) {
      const [row] = await database().select().from(exports).where(and(eq(exports.commandId, commandId), eq(exports.userId, userId), eq(exports.status, "ready"), gt(exports.expiresAt, now())));
      return row?.data ?? null;
    },

    async claimDelivery(): Promise<ClaimedAccountDelivery | null> {
      assertAccountWriter();
      const leaseId = randomUUID(), instant = now();
      return database().transaction(async tx => {
      const result = await tx.execute<{ command: AccountCommand; receiver: AccountReceiver; attempts: number }>(sql`
        select c.command, d.receiver, d.attempts from customer_account_deliveries d
        join customer_account_commands c on c.command_id = d.command_id
        where ((d.status = 'pending' and d.next_run_at <= ${instant}) or (d.status = 'delivering' and d.lease_until <= ${instant}))
        and not exists (select 1 from customer_account_commands prior
          where prior.user_id = c.user_id and prior.account_version < c.account_version
          and not exists (select 1 from customer_account_deliveries pd where pd.command_id = prior.command_id and pd.receiver = d.receiver and pd.status = 'acknowledged'))
        order by c.issued_at, c.account_version, d.receiver for update of d skip locked limit 1`);
      const row = result.rows[0];
      if (!row) return null;
      const command = parseAccountCommand(row.command), attempts = row.attempts + 1, leaseUntil = new Date(instant.getTime() + 90_000);
      if (!ACCOUNT_RECEIVERS.includes(row.receiver)) throw new Error("ACCOUNT_DELIVERY_RECEIPT_MISSING");
      const rows = await tx.update(deliveries).set({ status: "delivering", attempts, leaseId, leaseUntil }).where(and(eq(deliveries.commandId, command.commandId), eq(deliveries.receiver, row.receiver))).returning();
      const persisted = await tx.select().from(deliveries).where(and(eq(deliveries.commandId, command.commandId), eq(deliveries.receiver, row.receiver)));
      for (const receipt of [rows, persisted]) if (receipt.length !== 1 || receipt[0].commandId !== command.commandId || receipt[0].receiver !== row.receiver || receipt[0].status !== "delivering" || receipt[0].attempts !== attempts || receipt[0].leaseId !== leaseId || receipt[0].leaseUntil?.getTime() !== leaseUntil.getTime()) throw new Error("ACCOUNT_DELIVERY_CLAIM_RECEIPT_MISSING");
      return { command, receiver: row.receiver, attempts, leaseId };
      });
    },

    async settleDelivery(claim: ClaimedAccountDelivery, outcome: "acknowledged" | "retry" | "blocked", errorCode?: string): Promise<"settled" | "already-acknowledged" | "lease-lost"> {
      assertAccountWriter();
      return database().transaction(async tx => {
        const [user] = await tx.select().from(customerUsers).where(eq(customerUsers.id, claim.command.userId)).for("update");
        const rows = await tx.update(deliveries).set({ status: outcome === "retry" ? "pending" : outcome, leaseId: null, leaseUntil: null,
          nextRunAt: new Date(now().getTime() + Math.min(3_600_000, 5_000 * 2 ** Math.min(claim.attempts, 9))),
          acknowledgedAt: outcome === "acknowledged" ? now() : null, lastError: outcome === "acknowledged" ? null : errorCode ?? "receiver_unavailable",
        }).where(and(eq(deliveries.commandId, claim.command.commandId), eq(deliveries.receiver, claim.receiver), eq(deliveries.leaseId, claim.leaseId), eq(deliveries.status, "delivering"))).returning();
        if (!rows.length) {
          const [existing] = await tx.select().from(deliveries).where(and(eq(deliveries.commandId, claim.command.commandId), eq(deliveries.receiver, claim.receiver)));
          if (!existing) throw new Error("ACCOUNT_DELIVERY_RECEIPT_MISSING");
          if (existing.status === "acknowledged" && existing.acknowledgedAt !== null) return "already-acknowledged";
          if (existing.leaseId !== claim.leaseId) return "lease-lost";
          throw new Error("ACCOUNT_DELIVERY_RECEIPT_MISSING");
        }
        if (rows.length !== 1 || rows[0].commandId !== claim.command.commandId || rows[0].receiver !== claim.receiver || rows[0].status !== (outcome === "retry" ? "pending" : outcome) || rows[0].leaseId !== null || (outcome === "acknowledged" && rows[0].acknowledgedAt === null)) throw new Error("ACCOUNT_DELIVERY_RECEIPT_MISSING");
        const [persisted] = await tx.select().from(deliveries).where(and(eq(deliveries.commandId, claim.command.commandId), eq(deliveries.receiver, claim.receiver)));
        if (!persisted || !isDeepStrictEqual(persisted, rows[0])) throw new Error("ACCOUNT_DELIVERY_RECEIPT_MISSING");
        if (user?.status !== "suspended" || outcome !== "acknowledged") return "settled";
        const [latestStateCommand] = await tx.select().from(commands).where(and(eq(commands.userId, user.id), ne(commands.action, "export"))).orderBy(desc(commands.accountVersion)).limit(1);
        if (latestStateCommand?.action !== "restore") return "settled";
        const [predecessors] = await tx.select({ count: sql<string>`count(*)::text` }).from(commands).where(and(eq(commands.userId, user.id), sql`${commands.accountVersion} <= ${latestStateCommand.accountVersion}`));
        const incomplete = await tx.select({ commandId: commands.commandId }).from(commands).where(and(eq(commands.userId, user.id), sql`${commands.accountVersion} <= ${latestStateCommand.accountVersion}`,
          sql`(select count(*) from customer_account_deliveries d where d.command_id = ${commands.commandId} and d.receiver in ('course','community') and d.status = 'acknowledged' and d.acknowledged_at is not null) <> 2`)).limit(1);
        if (Number(predecessors.count) === latestStateCommand.accountVersion && !incomplete.length) {
          const restored = await tx.update(customerUsers).set({ status: "active" }).where(eq(customerUsers.id, user.id)).returning({ id: customerUsers.id, status: customerUsers.status });
          if (restored.length !== 1 || restored[0].id !== user.id || restored[0].status !== "active") throw new Error("ACCOUNT_RESTORE_RECEIPT_MISSING");
        }
        return "settled";
      });
    },

    async pendingExports(): Promise<Array<{ command: AccountCommand; frontendData: Record<string, unknown> }>> {
      const result = await database().select({ command: commands.command, frontendData: exports.frontendData }).from(exports)
        .innerJoin(commands, eq(commands.commandId, exports.commandId)).innerJoin(customerUsers, eq(customerUsers.id, exports.userId))
        .where(and(eq(exports.status, "pending"), ne(customerUsers.status, "deleted"), sql`(select count(*) from customer_account_deliveries d where d.command_id = ${exports.commandId} and d.receiver in ('course','community') and d.status = 'acknowledged' and d.acknowledged_at is not null) = 2`)).limit(10);
      return result.filter((row): row is { command: AccountCommand; frontendData: Record<string, unknown> } => row.frontendData !== null);
    },

    async completeExport(command: AccountCommand, data: Record<string, unknown>, sourceExpiries: Date[]): Promise<"ready" | "unchanged"> {
      assertAccountWriter();
      return database().transaction(async tx => {
        const [user] = await tx.select().from(customerUsers).where(eq(customerUsers.id, command.userId)).for("update");
        if (!user || user.status === "deleted") return "unchanged";
        const instant = now(), expiry = new Date(Math.min(instant.getTime() + EXPORT_MAX_AGE_MS, ...sourceExpiries.map(date => date.getTime())));
        if (!Number.isFinite(expiry.getTime()) || expiry <= instant) throw new AccountLifecycleError(410, "export_expired");
        const rows = await tx.update(exports).set({ status: "ready", data, frontendData: null, readyAt: instant, expiresAt: expiry }).where(and(eq(exports.commandId, command.commandId), eq(exports.userId, user.id), eq(exports.status, "pending"))).returning();
        if (rows.length === 1 && rows[0].commandId === command.commandId && rows[0].userId === user.id && rows[0].status === "ready" && rows[0].expiresAt?.getTime() === expiry.getTime() && rows[0].frontendData === null && isDeepStrictEqual(rows[0].data, data)) {
          const [persisted] = await tx.select().from(exports).where(eq(exports.commandId, command.commandId));
          if (persisted && isDeepStrictEqual(rows[0], persisted)) return "ready";
        }
        if (!rows.length) {
          const [existing] = await tx.select().from(exports).where(and(eq(exports.commandId, command.commandId), eq(exports.userId, user.id)));
          if (existing && existing.status !== "pending") return "unchanged";
        }
        throw new Error("ACCOUNT_EXPORT_RECEIPT_MISSING");
      });
    },

    async failExport(commandId: string): Promise<void> {
      assertAccountWriter();
      await database().transaction(async tx => {
        const [existing] = await tx.select(exportScrubFields).from(exports).where(eq(exports.commandId, commandId)).for("update");
        if (!existing) throw new Error("ACCOUNT_EXPORT_RECEIPT_MISSING");
        // A concurrent successful assembly remains authoritative. Terminal
        // failed/expired snapshots may only repair already-required byte removal.
        if (existing.status === "ready") return;
        if (!["pending", "failed", "expired"].includes(existing.status)) throw new Error("ACCOUNT_EXPORT_RECEIPT_MISSING");
        if (existing.status !== "pending" && existing.dataCleared === true && existing.frontendCleared === true) return;
        const expected = { ...existing, status: existing.status === "pending" ? "failed" : existing.status, dataCleared: true, frontendCleared: true };
        const rows = await tx.update(exports).set({ status: expected.status, data: null, frontendData: null })
          .where(and(eq(exports.commandId, commandId), eq(exports.status, existing.status))).returning(exportScrubFields);
        const [persisted] = await tx.select(exportScrubFields).from(exports).where(eq(exports.commandId, commandId));
        if (rows.length !== 1 || !isDeepStrictEqual(rows[0], expected) || !isDeepStrictEqual(persisted, expected)) throw new Error("ACCOUNT_EXPORT_RECEIPT_MISSING");
      });
    },

    async expireExports(): Promise<number> {
      assertAccountWriter();
      // Pending snapshots also contain PII. Expire them after 24h from their
      // command, even if a receiver never recovers. Repair bytes left in a
      // failed/expired snapshot without changing its terminal status or expiry.
      return database().transaction(async tx => {
        const instant = now();
        const expired = await tx.select(exportScrubFields).from(exports).innerJoin(commands, eq(commands.commandId, exports.commandId))
          .where(sql`(${exports.status} = 'ready' and ${exports.expiresAt} <= ${instant})
            or (${exports.status} = 'pending' and ${commands.issuedAt} <= ${new Date(instant.getTime() - EXPORT_MAX_AGE_MS)})
            or (${exports.status} in ('failed', 'expired') and (${exports.data} is not null or ${exports.frontendData} is not null))`)
          .orderBy(commands.issuedAt).limit(100).for("update", { of: exports, skipLocked: true });
        if (!expired.length) return 0;
        const expected = expired.map(row => ({ ...row, status: row.status === "failed" ? "failed" : "expired", dataCleared: true, frontendCleared: true }));
        const commandIds = expected.map(row => row.commandId);
        const rows = await tx.update(exports).set({ status: sql`case when ${exports.status} = 'failed' then 'failed' else 'expired' end`, data: null, frontendData: null })
          .where(inArray(exports.commandId, commandIds)).returning(exportScrubFields);
        const persisted = await tx.select(exportScrubFields).from(exports).where(inArray(exports.commandId, commandIds));
        for (const receipts of [rows, persisted]) {
          if (receipts.length !== expected.length || expected.some(row => receipts.filter(receipt => isDeepStrictEqual(receipt, row)).length !== 1)) throw new Error("ACCOUNT_EXPORT_EXPIRY_RECEIPT_MISSING");
        }
        return rows.length;
      });
    },
  };
}
export type AccountLifecycleStore = ReturnType<typeof createAccountLifecycleStore>;
