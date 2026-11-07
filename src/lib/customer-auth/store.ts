import "server-only";

import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { Adapter, AdapterAccount, AdapterUser } from "next-auth/adapters";
import { getPrivateDb } from "@/lib/private-db/client";
import { markWriterOperationUncertain } from "@/lib/writer-admission/context";
import { assertCustomerWriterContext, customerVerificationWrites } from "./context";
import { CUSTOMER_EMAIL_MAX_AGE, hashCustomerSession, normalizeCustomerEmail } from "./policy";
import { customerAuthThrottle, customerProviderLinks, customerSessions, customerUsers, customerVerificationTokens } from "./schema";

type Database = ReturnType<typeof getPrivateDb>;
type Customer = typeof customerUsers.$inferSelect;
const asUser = (user: Customer): AdapterUser => ({ id: user.id, email: user.email, emailVerified: user.emailVerified, name: user.name, image: null });
const sameInstant = (left: Date | null, right: Date | null): boolean => left?.getTime() === right?.getTime();
function requireReceipt(condition: unknown): asserts condition {
  if (!condition) throw new Error("CUSTOMER_AUTH_PERSISTENCE_RECEIPT");
}

export function createCustomerAuthStore(database: () => Database = getPrivateDb, now: () => Date = () => new Date()) {
  const findUser = async (predicate: ReturnType<typeof eq>) => (await database().select().from(customerUsers).where(predicate).limit(1))[0] ?? null;
  const adapter: Adapter = {
    async createUser(input) {
      assertCustomerWriterContext();
      return database().transaction(async tx => {
        const expected = { email: normalizeCustomerEmail(input.email), name: input.name?.slice(0, 200) ?? null, emailVerified: input.emailVerified ?? null };
        const [inserted] = await tx.insert(customerUsers).values(expected).returning();
        requireReceipt(inserted);
        const [user] = await tx.select().from(customerUsers).where(eq(customerUsers.id, inserted.id)).for("share");
        requireReceipt(user && user.email === expected.email && user.name === expected.name && sameInstant(user.emailVerified, expected.emailVerified) && user.status === "active" && user.accountVersion === 0);
        return asUser(user);
      });
    },
    async getUser(id) {
      const user = await findUser(eq(customerUsers.id, id));
      return user ? asUser(user) : null;
    },
    async getUserByEmail(email) {
      const user = await findUser(eq(customerUsers.email, normalizeCustomerEmail(email)));
      return user ? asUser(user) : null;
    },
    async getUserByAccount({ provider, providerAccountId }) {
      const [row] = await database().select({ user: customerUsers }).from(customerProviderLinks)
        .innerJoin(customerUsers, eq(customerUsers.id, customerProviderLinks.userId))
        .where(and(eq(customerProviderLinks.provider, provider), eq(customerProviderLinks.providerAccountId, providerAccountId))).limit(1);
      return row ? asUser(row.user) : null;
    },
    async updateUser(input) {
      assertCustomerWriterContext();
      return database().transaction(async tx => {
        const [existing] = await tx.select().from(customerUsers).where(eq(customerUsers.id, input.id)).for("update");
        if (!existing || existing.status !== "active" || input.email && normalizeCustomerEmail(input.email) !== existing.email) throw new Error("CUSTOMER_UPDATE_DENIED");
        const changes = {
          ...(input.name !== undefined ? { name: input.name?.slice(0, 200) ?? null } : {}),
          ...(input.emailVerified !== undefined ? { emailVerified: input.emailVerified } : {}),
        };
        if (!Object.keys(changes).length) return asUser(existing);
        const [updated] = await tx.update(customerUsers).set(changes).where(eq(customerUsers.id, input.id)).returning();
        requireReceipt(updated);
        const [user] = await tx.select().from(customerUsers).where(eq(customerUsers.id, input.id));
        requireReceipt(user && user.email === existing.email && user.status === "active" && user.accountVersion === existing.accountVersion &&
          user.name === (changes.name !== undefined ? changes.name : existing.name) && sameInstant(user.emailVerified, changes.emailVerified !== undefined ? changes.emailVerified : existing.emailVerified));
        return asUser(user);
      });
    },
    async linkAccount(account) {
      assertCustomerWriterContext();
      if (account.provider !== "google" || account.type !== "oidc" || !account.providerAccountId || account.providerAccountId.length > 255) throw new Error("CUSTOMER_PROVIDER_DENIED");
      await database().transaction(async tx => {
        const [user] = await tx.select().from(customerUsers).where(eq(customerUsers.id, account.userId)).for("update");
        if (!user || user.status !== "active") throw new Error("CUSTOMER_PROVIDER_DENIED");
        await tx.insert(customerProviderLinks).values({ userId: account.userId, provider: account.provider, providerAccountId: account.providerAccountId, type: account.type });
        const verifiedAt = user.emailVerified ?? now();
        await tx.update(customerUsers).set({ emailVerified: verifiedAt }).where(eq(customerUsers.id, user.id));
        const [link] = await tx.select().from(customerProviderLinks).where(and(eq(customerProviderLinks.provider, account.provider), eq(customerProviderLinks.providerAccountId, account.providerAccountId)));
        const [verified] = await tx.select().from(customerUsers).where(eq(customerUsers.id, user.id));
        requireReceipt(link && link.userId === user.id && link.type === account.type && verified && verified.email === user.email && verified.status === "active" &&
          verified.accountVersion === user.accountVersion && sameInstant(verified.emailVerified, verifiedAt));
      });
      return { userId: account.userId, provider: account.provider, providerAccountId: account.providerAccountId, type: account.type } as AdapterAccount;
    },
    async createSession(session) {
      assertCustomerWriterContext();
      await database().transaction(async tx => {
        const [user] = await tx.select().from(customerUsers).where(eq(customerUsers.id, session.userId)).for("update");
        if (!user || user.status !== "active") throw new Error("CUSTOMER_SESSION_DENIED");
        const tokenHash = hashCustomerSession(session.sessionToken);
        await tx.insert(customerSessions).values({ userId: session.userId, tokenHash, expires: session.expires });
        const [persisted] = await tx.select().from(customerSessions).where(eq(customerSessions.tokenHash, tokenHash));
        requireReceipt(persisted && persisted.userId === session.userId && sameInstant(persisted.expires, session.expires));
      });
      return session;
    },
    async getSessionAndUser(sessionToken) {
      const [row] = await database().select({ session: customerSessions, user: customerUsers }).from(customerSessions)
        .innerJoin(customerUsers, eq(customerUsers.id, customerSessions.userId))
        .where(and(eq(customerSessions.tokenHash, hashCustomerSession(sessionToken)), gt(customerSessions.expires, now()), eq(customerUsers.status, "active"))).limit(1);
      return row ? { session: { sessionToken, userId: row.user.id, expires: row.session.expires }, user: asUser(row.user) } : null;
    },
    // Absolute sessions: no silent rolling extension and no writes during reads.
    async updateSession(session) {
      assertCustomerWriterContext();
      const found = await adapter.getSessionAndUser!(session.sessionToken);
      return found?.session ?? null;
    },
    async deleteSession(sessionToken) {
      assertCustomerWriterContext();
      await database().transaction(async tx => {
        const tokenHash = hashCustomerSession(sessionToken);
        await tx.delete(customerSessions).where(eq(customerSessions.tokenHash, tokenHash));
        const [remaining] = await tx.select().from(customerSessions).where(eq(customerSessions.tokenHash, tokenHash));
        requireReceipt(!remaining);
      });
    },
    async createVerificationToken(input) {
      assertCustomerWriterContext();
      const identifier = normalizeCustomerEmail(input.identifier), scope = customerVerificationWrites();
      // Auth.js calls the provider and adapter concurrently. Both must share the
      // original durable write, never reinsert a proof consumed during delivery.
      const existing = scope.get(input.token);
      if (existing) {
        requireReceipt(existing.identifier === identifier && existing.expiresAt === input.expires.getTime());
        return existing.result;
      }
      const instant = now(), expires = new Date(Math.min(input.expires.getTime(), instant.getTime() + CUSTOMER_EMAIL_MAX_AGE * 1000));
      const result = database().transaction(async tx => {
        await tx.insert(customerVerificationTokens).values({ identifier, token: input.token, expires }).onConflictDoNothing();
        const [persisted] = await tx.select().from(customerVerificationTokens).where(eq(customerVerificationTokens.token, input.token)).for("share");
        requireReceipt(persisted && persisted.identifier === identifier && persisted.expires <= expires && (expires <= instant || persisted.expires > instant));
        return persisted;
      });
      scope.set(input.token, { identifier, expiresAt: input.expires.getTime(), result });
      return result;
    },
    async useVerificationToken({ identifier, token }) {
      assertCustomerWriterContext();
      return database().transaction(async tx => {
        const predicate = and(eq(customerVerificationTokens.identifier, normalizeCustomerEmail(identifier)), eq(customerVerificationTokens.token, token));
        const [existing] = await tx.select().from(customerVerificationTokens).where(predicate).for("update");
        if (!existing) return null;
        const [row] = await tx.delete(customerVerificationTokens).where(predicate).returning();
        const [remaining] = await tx.select().from(customerVerificationTokens).where(eq(customerVerificationTokens.token, token));
        requireReceipt(row && row.identifier === existing.identifier && sameInstant(row.expires, existing.expires) && !remaining);
        return row.expires > now() ? row : null;
      });
    },
  };

  // Auth.js converts adapter failures into redirects. Preserve uncertainty in
  // the enclosing durable operation even when that library catches the error.
  const mutations = new Set(["createUser", "updateUser", "linkAccount", "createSession", "updateSession", "deleteSession", "createVerificationToken", "useVerificationToken"]);
  const guardedAdapter = Object.fromEntries(Object.entries(adapter).map(([name, method]) => {
    if (!mutations.has(name)) return [name, method];
    const operation = method as (...args: unknown[]) => Promise<unknown>;
    return [name, async (...args: unknown[]) => {
      assertCustomerWriterContext();
      try { return await operation(...args); }
      catch (error) { markWriterOperationUncertain(); throw error; }
    }];
  })) as Adapter;

  return {
    adapter: guardedAdapter,
    async isActive(email: string): Promise<boolean> {
      const user = await findUser(eq(customerUsers.email, normalizeCustomerEmail(email)));
      return !user || user.status === "active";
    },
    async consumeThrottle(key: string, limit: number, windowSeconds: number): Promise<boolean> {
      assertCustomerWriterContext();
      try {
        return await database().transaction(async tx => {
          const instant = now();
          // Each indexed cleanup is bounded; one login cannot inherit an arbitrary
          // maintenance backlog. No request allocates more than its fixed buckets.
          await tx.delete(customerAuthThrottle).where(and(lt(customerAuthThrottle.resetsAt, instant), inArray(customerAuthThrottle.key,
            tx.select({ key: customerAuthThrottle.key }).from(customerAuthThrottle).where(lt(customerAuthThrottle.resetsAt, instant)).orderBy(customerAuthThrottle.resetsAt).limit(100))));
          await tx.delete(customerVerificationTokens).where(and(lt(customerVerificationTokens.expires, instant), inArray(customerVerificationTokens.token,
            tx.select({ token: customerVerificationTokens.token }).from(customerVerificationTokens).where(lt(customerVerificationTokens.expires, instant)).orderBy(customerVerificationTokens.expires).limit(100))));
          await tx.delete(customerSessions).where(and(lt(customerSessions.expires, instant), inArray(customerSessions.tokenHash,
            tx.select({ tokenHash: customerSessions.tokenHash }).from(customerSessions).where(lt(customerSessions.expires, instant)).orderBy(customerSessions.expires).limit(100))));
          const [before] = await tx.select().from(customerAuthThrottle).where(eq(customerAuthThrottle.key, key)).for("update");
          const resetsAt = new Date(instant.getTime() + windowSeconds * 1000);
          const [row] = await tx.insert(customerAuthThrottle).values({ key, attempts: 1, resetsAt })
            .onConflictDoUpdate({ target: customerAuthThrottle.key, set: {
              attempts: sql`CASE WHEN ${customerAuthThrottle.resetsAt} <= ${instant.toISOString()}::timestamptz THEN 1 ELSE ${customerAuthThrottle.attempts} + 1 END`,
              resetsAt: sql`CASE WHEN ${customerAuthThrottle.resetsAt} <= ${instant.toISOString()}::timestamptz THEN ${resetsAt.toISOString()}::timestamptz ELSE ${customerAuthThrottle.resetsAt} END`,
            } }).returning();
          const [persisted] = await tx.select().from(customerAuthThrottle).where(eq(customerAuthThrottle.key, key));
          requireReceipt(row && persisted && row.key === key && row.attempts >= 1 && row.resetsAt > instant &&
            row.attempts === persisted.attempts && sameInstant(row.resetsAt, persisted.resetsAt));
          if (before) requireReceipt(row.attempts === (before.resetsAt <= instant ? 1 : before.attempts + 1) && sameInstant(row.resetsAt, before.resetsAt <= instant ? resetsAt : before.resetsAt));
          else requireReceipt(row.resetsAt <= resetsAt);
          return persisted.attempts <= limit;
        });
      } catch (error) { markWriterOperationUncertain(); throw error; }
    },
  };
}

export type CustomerAuthStore = ReturnType<typeof createCustomerAuthStore>;
