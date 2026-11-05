import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, ne, sql } from "drizzle-orm";
import { customerProviderLinks, customerSessions, customerUsers, customerVerificationTokens } from "@/lib/customer-auth/schema";
import { getPrivateDb } from "@/lib/private-db/client";
import { assertAccountWriter } from "./context";
import { ACCOUNT_RECEIVERS, AccountLifecycleError, assertFreshCustomerSession, EXPORT_MAX_AGE_MS, parseAccountCommand, type AccountAction, type AccountCommand, type AccountReceiver } from "./policy";
import { customerAccountCommands as commands, customerAccountDeliveries as deliveries, customerAccountExports as exports, customerAccountPreferences as preferences } from "./schema";
import type { AccountCustomerSession } from "./session";

type Database = ReturnType<typeof getPrivateDb>;
export type AccountRequester = { kind: "customer"; session: AccountCustomerSession } | { kind: "admin"; adminId: string };
export interface ClaimedAccountDelivery { command: AccountCommand; receiver: AccountReceiver; leaseId: string; attempts: number }

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
        if (user.accountVersion >= Number.MAX_SAFE_INTEGER) throw new AccountLifecycleError(409, "account_version_exhausted");
        const command = parseAccountCommand({ version: 1, commandId: randomUUID(), userId: user.id, accountVersion: user.accountVersion + 1, action: input.action, issuedAt: instant.toISOString() });
        await tx.insert(commands).values({ ...command, command, idempotencyKey: input.idempotencyKey, issuedAt: instant, requestedByAdminId: input.requester.kind === "admin" ? input.requester.adminId : null });
        await tx.insert(deliveries).values(ACCOUNT_RECEIVERS.map(receiver => ({ commandId: command.commandId, receiver, nextRunAt: instant })));
        await tx.update(customerUsers).set({ accountVersion: command.accountVersion,
          ...(input.action === "export" ? {} : { status: input.action === "delete" ? "deleted" : "suspended" }),
          ...(input.action === "delete" ? { email: `deleted+${user.id}@account.invalid`, emailVerified: null, name: null } : {}),
        }).where(eq(customerUsers.id, user.id));
        if (input.action !== "export") await tx.delete(customerSessions).where(eq(customerSessions.userId, user.id));
        if (input.action === "delete") {
          await tx.delete(customerProviderLinks).where(eq(customerProviderLinks.userId, user.id));
          await tx.delete(customerVerificationTokens).where(eq(customerVerificationTokens.identifier, user.email));
          await tx.delete(preferences).where(eq(preferences.userId, user.id));
          await tx.update(exports).set({ frontendData: null, data: null, status: "expired", expiresAt: instant }).where(eq(exports.userId, user.id));
          // Existing financial/booking/marketing records have independent
          // retention and no verified immutable customer relationship in P2.
          // Never infer ownership or destructive authority from an email match.
        }
        if (input.action === "export") {
          const links = await tx.select({ provider: customerProviderLinks.provider, linkedAt: customerProviderLinks.createdAt }).from(customerProviderLinks).where(eq(customerProviderLinks.userId, user.id));
          const [savedPreferences] = await tx.select({ learningUpdates: preferences.learningUpdates }).from(preferences).where(eq(preferences.userId, user.id));
          const history = await tx.select({ commandId: commands.commandId, accountVersion: commands.accountVersion, action: commands.action, issuedAt: commands.issuedAt }).from(commands).where(eq(commands.userId, user.id)).orderBy(asc(commands.accountVersion));
          await tx.insert(exports).values({ commandId: command.commandId, userId: user.id, frontendData: {
            profile: { userId: user.id, email: user.email, name: user.name, emailVerified: user.emailVerified?.toISOString() ?? null, createdAt: user.createdAt.toISOString() },
            signInMethods: links.map(link => ({ provider: link.provider, linkedAt: link.linkedAt.toISOString() })),
            preferences: savedPreferences ?? { learningUpdates: false },
            commands: history.map(row => ({ ...row, issuedAt: row.issuedAt.toISOString() })),
            scope: "Records linked to this immutable customer UUID. Guest financial, booking and marketing records retain their separate verified access and retention processes.",
          } });
        }
        return command;
      });
    },

    async updatePreferences(session: AccountCustomerSession, learningUpdates: boolean): Promise<void> {
      assertAccountWriter();
      await database().transaction(async tx => {
        const [user] = await tx.select().from(customerUsers).where(eq(customerUsers.id, session.userId)).for("update");
        const [current] = await tx.select().from(customerSessions).where(and(eq(customerSessions.tokenHash, session.tokenHash), eq(customerSessions.userId, session.userId), gt(customerSessions.expires, now())));
        if (user?.status !== "active" || !current) throw new AccountLifecycleError(401, "sign_in_required");
        await tx.insert(preferences).values({ userId: user.id, learningUpdates, updatedAt: now() }).onConflictDoUpdate({ target: preferences.userId, set: { learningUpdates, updatedAt: now() } });
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
      const result = await database().execute<{ command: AccountCommand; receiver: AccountReceiver; attempts: number }>(sql`with next as (
        select d.command_id, d.receiver from customer_account_deliveries d
        join customer_account_commands c on c.command_id = d.command_id
        where ((d.status = 'pending' and d.next_run_at <= ${instant}) or (d.status = 'delivering' and d.lease_until <= ${instant}))
        and not exists (select 1 from customer_account_commands prior join customer_account_deliveries pd on pd.command_id = prior.command_id
          where prior.user_id = c.user_id and prior.account_version < c.account_version and pd.receiver = d.receiver and pd.status <> 'acknowledged')
        order by c.issued_at, c.account_version, d.receiver for update of d skip locked limit 1
      ) update customer_account_deliveries d set status = 'delivering', attempts = d.attempts + 1, lease_id = ${leaseId}::uuid,
        lease_until = ${new Date(instant.getTime() + 90_000)} from next, customer_account_commands c
        where d.command_id = next.command_id and d.receiver = next.receiver and c.command_id = d.command_id
        returning c.command, d.receiver, d.attempts`);
      const row = result.rows[0];
      return row ? { command: parseAccountCommand(row.command), receiver: row.receiver, attempts: row.attempts, leaseId } : null;
    },

    async settleDelivery(claim: ClaimedAccountDelivery, outcome: "acknowledged" | "retry" | "blocked", errorCode?: string): Promise<void> {
      assertAccountWriter();
      await database().transaction(async tx => {
        const [user] = await tx.select().from(customerUsers).where(eq(customerUsers.id, claim.command.userId)).for("update");
        const rows = await tx.update(deliveries).set({ status: outcome === "retry" ? "pending" : outcome, leaseId: null, leaseUntil: null,
          nextRunAt: new Date(now().getTime() + Math.min(3_600_000, 5_000 * 2 ** Math.min(claim.attempts, 9))),
          acknowledgedAt: outcome === "acknowledged" ? now() : null, lastError: outcome === "acknowledged" ? null : errorCode ?? "receiver_unavailable",
        }).where(and(eq(deliveries.commandId, claim.command.commandId), eq(deliveries.receiver, claim.receiver), eq(deliveries.leaseId, claim.leaseId), eq(deliveries.status, "delivering"))).returning({ commandId: deliveries.commandId });
        if (!rows.length || user?.status !== "suspended" || outcome !== "acknowledged") return;
        const [latestStateCommand] = await tx.select().from(commands).where(and(eq(commands.userId, user.id), ne(commands.action, "export"))).orderBy(desc(commands.accountVersion)).limit(1);
        if (latestStateCommand?.action !== "restore") return;
        const incomplete = await tx.select({ commandId: commands.commandId }).from(commands).innerJoin(deliveries, eq(deliveries.commandId, commands.commandId)).where(and(eq(commands.userId, user.id), sql`${commands.accountVersion} <= ${latestStateCommand.accountVersion}`, ne(deliveries.status, "acknowledged"))).limit(1);
        if (!incomplete.length) await tx.update(customerUsers).set({ status: "active" }).where(eq(customerUsers.id, user.id));
      });
    },

    async pendingExports(): Promise<Array<{ command: AccountCommand; frontendData: Record<string, unknown> }>> {
      const result = await database().select({ command: commands.command, frontendData: exports.frontendData }).from(exports)
        .innerJoin(commands, eq(commands.commandId, exports.commandId)).innerJoin(customerUsers, eq(customerUsers.id, exports.userId))
        .where(and(eq(exports.status, "pending"), ne(customerUsers.status, "deleted"), sql`not exists (select 1 from customer_account_deliveries d where d.command_id = ${exports.commandId} and d.status <> 'acknowledged')`)).limit(10);
      return result.filter((row): row is { command: AccountCommand; frontendData: Record<string, unknown> } => row.frontendData !== null);
    },

    async completeExport(command: AccountCommand, data: Record<string, unknown>, sourceExpiries: Date[]): Promise<void> {
      assertAccountWriter();
      await database().transaction(async tx => {
        const [user] = await tx.select().from(customerUsers).where(eq(customerUsers.id, command.userId)).for("update");
        if (!user || user.status === "deleted") return;
        const instant = now(), expiry = new Date(Math.min(instant.getTime() + EXPORT_MAX_AGE_MS, ...sourceExpiries.map(date => date.getTime())));
        if (!Number.isFinite(expiry.getTime()) || expiry <= instant) throw new AccountLifecycleError(410, "export_expired");
        await tx.update(exports).set({ status: "ready", data, frontendData: null, readyAt: instant, expiresAt: expiry }).where(and(eq(exports.commandId, command.commandId), eq(exports.userId, user.id), eq(exports.status, "pending")));
      });
    },

    async failExport(commandId: string): Promise<void> {
      assertAccountWriter();
      await database().update(exports).set({ status: "failed", data: null, frontendData: null }).where(and(eq(exports.commandId, commandId), eq(exports.status, "pending")));
    },

    async expireExports(): Promise<number> {
      assertAccountWriter();
      // Pending snapshots also contain PII. Expire them after 24h from their
      // command, even if a receiver never recovers; a retry cannot extend them.
      const result = await database().execute(sql`with expired as (
        select e.command_id from customer_account_exports e join customer_account_commands c on c.command_id = e.command_id
        where (e.status = 'ready' and e.expires_at <= ${now()}) or (e.status = 'pending' and c.issued_at <= ${new Date(now().getTime() - EXPORT_MAX_AGE_MS)})
        order by c.issued_at for update of e skip locked limit 100
      ) update customer_account_exports e set status = 'expired', data = null, frontend_data = null
        from expired where e.command_id = expired.command_id returning e.command_id`);
      return result.rowCount ?? 0;
    },
  };
}
export type AccountLifecycleStore = ReturnType<typeof createAccountLifecycleStore>;
