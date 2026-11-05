import "server-only";

import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { Adapter, AdapterAccount, AdapterUser } from "next-auth/adapters";
import { getPrivateDb } from "@/lib/private-db/client";
import { markWriterOperationUncertain } from "@/lib/writer-admission/context";
import { assertCustomerWriterContext } from "./context";
import { CUSTOMER_EMAIL_MAX_AGE, hashCustomerSession, normalizeCustomerEmail } from "./policy";
import { customerAuthThrottle, customerProviderLinks, customerSessions, customerUsers, customerVerificationTokens } from "./schema";

type Database = ReturnType<typeof getPrivateDb>;
type Customer = typeof customerUsers.$inferSelect;
const asUser = (user: Customer): AdapterUser => ({ id: user.id, email: user.email, emailVerified: user.emailVerified, name: user.name, image: null });

export function createCustomerAuthStore(database: () => Database = getPrivateDb, now: () => Date = () => new Date()) {
  const findUser = async (predicate: ReturnType<typeof eq>) => (await database().select().from(customerUsers).where(predicate).limit(1))[0] ?? null;
  const adapter: Adapter = {
    async createUser(input) {
      assertCustomerWriterContext();
      const [user] = await database().insert(customerUsers).values({ email: normalizeCustomerEmail(input.email), name: input.name?.slice(0, 200) ?? null, emailVerified: input.emailVerified }).returning();
      return asUser(user);
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
        const [user] = await tx.update(customerUsers).set({
          ...(input.name !== undefined ? { name: input.name?.slice(0, 200) ?? null } : {}),
          ...(input.emailVerified !== undefined ? { emailVerified: input.emailVerified } : {}),
        }).where(eq(customerUsers.id, input.id)).returning();
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
        await tx.update(customerUsers).set({ emailVerified: user.emailVerified ?? now() }).where(eq(customerUsers.id, user.id));
      });
      return { userId: account.userId, provider: account.provider, providerAccountId: account.providerAccountId, type: account.type } as AdapterAccount;
    },
    async createSession(session) {
      assertCustomerWriterContext();
      await database().transaction(async tx => {
        const [user] = await tx.select().from(customerUsers).where(eq(customerUsers.id, session.userId)).for("update");
        if (!user || user.status !== "active") throw new Error("CUSTOMER_SESSION_DENIED");
        await tx.insert(customerSessions).values({ userId: session.userId, tokenHash: hashCustomerSession(session.sessionToken), expires: session.expires });
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
      await database().delete(customerSessions).where(eq(customerSessions.tokenHash, hashCustomerSession(sessionToken)));
    },
    async createVerificationToken(input) {
      assertCustomerWriterContext();
      const expires = new Date(Math.min(input.expires.getTime(), now().getTime() + CUSTOMER_EMAIL_MAX_AGE * 1000));
      const token = { ...input, identifier: normalizeCustomerEmail(input.identifier), expires };
      // The email sender also persists this exact hash before sending. Concurrent
      // duplicate insert is harmless and never extends the original expiry.
      await database().insert(customerVerificationTokens).values(token).onConflictDoNothing();
      return token;
    },
    async useVerificationToken({ identifier, token }) {
      assertCustomerWriterContext();
      const [row] = await database().delete(customerVerificationTokens)
        .where(and(eq(customerVerificationTokens.identifier, normalizeCustomerEmail(identifier)), eq(customerVerificationTokens.token, token))).returning();
      return row && row.expires > now() ? row : null;
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
      const instant = now();
      // Each indexed cleanup is bounded; one login cannot inherit an arbitrary
      // maintenance backlog. No request allocates more than its fixed buckets.
      await database().delete(customerAuthThrottle).where(inArray(customerAuthThrottle.key,
        database().select({ key: customerAuthThrottle.key }).from(customerAuthThrottle).where(lt(customerAuthThrottle.resetsAt, instant)).orderBy(customerAuthThrottle.resetsAt).limit(100)));
      await database().delete(customerVerificationTokens).where(inArray(customerVerificationTokens.token,
        database().select({ token: customerVerificationTokens.token }).from(customerVerificationTokens).where(lt(customerVerificationTokens.expires, instant)).orderBy(customerVerificationTokens.expires).limit(100)));
      await database().delete(customerSessions).where(inArray(customerSessions.tokenHash,
        database().select({ tokenHash: customerSessions.tokenHash }).from(customerSessions).where(lt(customerSessions.expires, instant)).orderBy(customerSessions.expires).limit(100)));
      const resetsAt = new Date(instant.getTime() + windowSeconds * 1000);
      const [row] = await database().insert(customerAuthThrottle).values({ key, attempts: 1, resetsAt })
        .onConflictDoUpdate({ target: customerAuthThrottle.key, set: {
          attempts: sql`CASE WHEN ${customerAuthThrottle.resetsAt} <= ${instant.toISOString()}::timestamptz THEN 1 ELSE ${customerAuthThrottle.attempts} + 1 END`,
          resetsAt: sql`CASE WHEN ${customerAuthThrottle.resetsAt} <= ${instant.toISOString()}::timestamptz THEN ${resetsAt.toISOString()}::timestamptz ELSE ${customerAuthThrottle.resetsAt} END`,
        } }).returning();
      return row.attempts <= limit;
    },
  };
}

export type CustomerAuthStore = ReturnType<typeof createCustomerAuthStore>;
