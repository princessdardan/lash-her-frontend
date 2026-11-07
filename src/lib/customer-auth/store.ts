import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { Adapter, AdapterAccount, AdapterUser } from "next-auth/adapters";
import { getPrivateDb } from "@/lib/private-db/client";
import { currentWriterIdentityCustomerId, currentWriterIdentityEnrollment, markWriterOperationUncertain, matchesWriterIdentityEnrollment, type WriterIdentityEnrollment } from "@/lib/writer-admission/context";
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

class CustomerIdentitySelectionDenied extends Error {
  constructor() { super("CUSTOMER_IDENTITY_SELECTION_DENIED"); }
}

function selectedCustomer(predicate: ReturnType<typeof and>, selectedId: string | undefined) {
  return selectedId === undefined ? predicate : and(predicate, eq(customerUsers.id, selectedId), eq(customerUsers.status, "active"));
}

type EnrollmentProof = { provider: "google"; email: string; subject: string } | { provider: "resend"; email: string };
type EnrollmentAttempt = { proof?: EnrollmentProof; resendVerifiedEmail?: string; newUserId?: string };

export function customerEnrollmentScopeId(selection: WriterIdentityEnrollment): string {
  return createHash("sha256").update(JSON.stringify(["lash-her:customer-enrollment:scope:v1", selection.provider, selection.nonce, selection.emailDigest])).digest("hex");
}

export function generateCustomerSessionToken(): string {
  const enrollment = currentWriterIdentityEnrollment();
  const entropy = randomUUID();
  return enrollment ? `${customerEnrollmentScopeId(enrollment)}.${entropy}` : entropy;
}

function enrollmentVerificationToken(selection: WriterIdentityEnrollment, token: string): string {
  return createHash("sha256").update(JSON.stringify(["lash-her:customer-enrollment:verification:v1", customerEnrollmentScopeId(selection), token])).digest("hex");
}

export function createCustomerAuthStore(database: () => Database = getPrivateDb, now: () => Date = () => new Date()) {
  const enrollmentAttempts = new WeakMap<ReturnType<typeof customerVerificationWrites>, EnrollmentAttempt>();
  const enrollmentAttempt = (): EnrollmentAttempt => {
    const request = customerVerificationWrites();
    const existing = enrollmentAttempts.get(request);
    if (existing) return existing;
    const attempt: EnrollmentAttempt = {};
    enrollmentAttempts.set(request, attempt);
    return attempt;
  };
  const findUser = async (predicate: ReturnType<typeof eq>, selectedId = currentWriterIdentityCustomerId()) =>
    (await database().select().from(customerUsers).where(selectedCustomer(predicate, selectedId)).limit(1))[0] ?? null;
  const findLiveSession = async (sessionToken: string, selectedId?: string) => {
    const [row] = await database().select({ session: customerSessions, user: customerUsers }).from(customerSessions)
      .innerJoin(customerUsers, eq(customerUsers.id, customerSessions.userId))
      .where(selectedCustomer(and(eq(customerSessions.tokenHash, hashCustomerSession(sessionToken)), gt(customerSessions.expires, now()),
        eq(customerUsers.status, "active")), selectedId)).limit(1);
    return row;
  };
  const adapter: Adapter = {
    async createUser(input) {
      assertCustomerWriterContext();
      if (currentWriterIdentityCustomerId() !== undefined) throw new CustomerIdentitySelectionDenied();
      const enrollment = currentWriterIdentityEnrollment();
      const attempt = enrollment && enrollmentAttempt();
      const proof = attempt?.proof;
      const email = normalizeCustomerEmail(input.email);
      if (enrollment && (!proof || proof.provider !== enrollment.provider || proof.email !== email || attempt?.newUserId ||
        !matchesWriterIdentityEnrollment(enrollment, email))) throw new CustomerIdentitySelectionDenied();
      const user = await database().transaction(async tx => {
        const expected = { email, name: input.name?.slice(0, 200) ?? null,
          emailVerified: proof?.provider === "google" ? now() : input.emailVerified ?? null };
        const insert = tx.insert(customerUsers).values(expected);
        const [inserted] = await (enrollment ? insert.onConflictDoNothing({ target: customerUsers.email }) : insert).returning();
        if (enrollment && !inserted) throw new CustomerIdentitySelectionDenied();
        requireReceipt(inserted);
        if (proof?.provider === "google") {
          // A racing existing subject must roll back the fresh UUID as well.
          const [link] = await tx.insert(customerProviderLinks).values({ userId: inserted.id, provider: "google", type: "oidc", providerAccountId: proof.subject })
            .onConflictDoNothing({ target: [customerProviderLinks.provider, customerProviderLinks.providerAccountId] }).returning();
          if (!link) throw new CustomerIdentitySelectionDenied();
          requireReceipt(link.userId === inserted.id && link.providerAccountId === proof.subject && link.provider === "google" && link.type === "oidc");
        }
        const [user] = await tx.select().from(customerUsers).where(eq(customerUsers.id, inserted.id)).for("share");
        requireReceipt(user && user.email === expected.email && user.name === expected.name && sameInstant(user.emailVerified, expected.emailVerified) && user.status === "active" && user.accountVersion === 0);
        return asUser(user);
      });
      if (attempt) attempt.newUserId = user.id;
      return user;
    },
    async getUser(id) {
      const user = await findUser(eq(customerUsers.id, id));
      const enrollment = currentWriterIdentityEnrollment();
      if (enrollment && user && !matchesWriterIdentityEnrollment(enrollment, user.email)) return null;
      return user ? asUser(user) : null;
    },
    async getUserByEmail(email) {
      const normalized = normalizeCustomerEmail(email);
      const enrollment = currentWriterIdentityEnrollment();
      if (enrollment && !matchesWriterIdentityEnrollment(enrollment, normalized)) return null;
      const user = await findUser(eq(customerUsers.email, normalized));
      return user ? asUser(user) : null;
    },
    async getUserByAccount({ provider, providerAccountId }) {
      const enrollment = currentWriterIdentityEnrollment();
      if (enrollment && (provider !== "google" || enrollment.provider !== provider)) return null;
      const selectedId = currentWriterIdentityCustomerId();
      const [row] = await database().select({ user: customerUsers }).from(customerProviderLinks)
        .innerJoin(customerUsers, eq(customerUsers.id, customerProviderLinks.userId))
        .where(selectedCustomer(and(eq(customerProviderLinks.provider, provider), eq(customerProviderLinks.providerAccountId, providerAccountId)), selectedId)).limit(1);
      return row ? asUser(row.user) : null;
    },
    async updateUser(input) {
      assertCustomerWriterContext();
      if (currentWriterIdentityEnrollment()) throw new CustomerIdentitySelectionDenied();
      const selectedId = currentWriterIdentityCustomerId();
      if (selectedId !== undefined && input.id !== selectedId) throw new CustomerIdentitySelectionDenied();
      return database().transaction(async tx => {
        const [existing] = await tx.select().from(customerUsers).where(eq(customerUsers.id, input.id)).for("update");
        if (!existing || existing.status !== "active" || input.email && normalizeCustomerEmail(input.email) !== existing.email) {
          if (selectedId !== undefined) throw new CustomerIdentitySelectionDenied();
          throw new Error("CUSTOMER_UPDATE_DENIED");
        }
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
      if (currentWriterIdentityCustomerId() !== undefined) throw new CustomerIdentitySelectionDenied();
      const enrollment = currentWriterIdentityEnrollment();
      if (enrollment) {
        const { proof, newUserId } = enrollmentAttempt();
        if (enrollment.provider !== "google" || account.provider !== "google" || account.type !== "oidc" || proof?.provider !== "google" ||
          account.providerAccountId !== proof.subject || !newUserId || newUserId !== account.userId) throw new CustomerIdentitySelectionDenied();
        const user = await adapter.getUserByAccount!(account);
        requireReceipt(user?.id === newUserId && user.email === proof.email && user.emailVerified);
        return { userId: account.userId, provider: account.provider, providerAccountId: account.providerAccountId, type: account.type } as AdapterAccount;
      }
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
      const selectedId = currentWriterIdentityCustomerId();
      if (selectedId !== undefined && session.userId !== selectedId) throw new CustomerIdentitySelectionDenied();
      const enrollment = currentWriterIdentityEnrollment();
      if (enrollment) {
        const { newUserId } = enrollmentAttempt();
        if (!newUserId || newUserId !== session.userId || !session.sessionToken.startsWith(`${customerEnrollmentScopeId(enrollment)}.`)) {
          throw new CustomerIdentitySelectionDenied();
        }
      }
      await database().transaction(async tx => {
        const [user] = await tx.select().from(customerUsers).where(eq(customerUsers.id, session.userId)).for("update");
        if (!user || user.status !== "active") {
          if (selectedId !== undefined || enrollment) throw new CustomerIdentitySelectionDenied();
          throw new Error("CUSTOMER_SESSION_DENIED");
        }
        if (enrollment && !matchesWriterIdentityEnrollment(enrollment, user.email)) throw new CustomerIdentitySelectionDenied();
        const tokenHash = hashCustomerSession(session.sessionToken);
        await tx.insert(customerSessions).values({ userId: session.userId, tokenHash, expires: session.expires });
        const [persisted] = await tx.select().from(customerSessions).where(eq(customerSessions.tokenHash, tokenHash));
        requireReceipt(persisted && persisted.userId === session.userId && sameInstant(persisted.expires, session.expires));
      });
      return session;
    },
    async getSessionAndUser(sessionToken) {
      const enrollment = currentWriterIdentityEnrollment();
      if (enrollment && !sessionToken.startsWith(`${customerEnrollmentScopeId(enrollment)}.`)) return null;
      const row = await findLiveSession(sessionToken, currentWriterIdentityCustomerId());
      if (enrollment && row && !matchesWriterIdentityEnrollment(enrollment, row.user.email)) return null;
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
      if (currentWriterIdentityEnrollment()) return;
      const selectedId = currentWriterIdentityCustomerId();
      await database().transaction(async tx => {
        const tokenHash = hashCustomerSession(sessionToken);
        const byToken = eq(customerSessions.tokenHash, tokenHash);
        const predicate = selectedId === undefined ? byToken : and(byToken, eq(customerSessions.userId, selectedId));
        if (selectedId !== undefined) {
          const [owner] = await tx.select({ id: customerUsers.id }).from(customerUsers).where(selectedCustomer(undefined, selectedId)).for("share");
          if (!owner) return;
          const [session] = await tx.select({ userId: customerSessions.userId }).from(customerSessions).where(predicate).for("update");
          if (!session) return;
        }
        await tx.delete(customerSessions).where(predicate);
        const [remaining] = await tx.select().from(customerSessions).where(eq(customerSessions.tokenHash, tokenHash));
        requireReceipt(!remaining);
      });
    },
    async createVerificationToken(input) {
      assertCustomerWriterContext();
      const selectedId = currentWriterIdentityCustomerId();
      const identifier = normalizeCustomerEmail(input.identifier), scope = customerVerificationWrites();
      const enrollment = currentWriterIdentityEnrollment();
      if (enrollment && (enrollment.provider !== "resend" || !matchesWriterIdentityEnrollment(enrollment, identifier))) throw new CustomerIdentitySelectionDenied();
      const token = enrollment ? enrollmentVerificationToken(enrollment, input.token) : input.token;
      // Auth.js calls the provider and adapter concurrently. Both must share the
      // original durable write, never reinsert a proof consumed during delivery.
      const existing = scope.get(input.token);
      if (existing) {
        requireReceipt(existing.identifier === identifier && existing.expiresAt === input.expires.getTime());
        return existing.result;
      }
      const instant = now(), expires = new Date(Math.min(input.expires.getTime(), instant.getTime() + CUSTOMER_EMAIL_MAX_AGE * 1000));
      const result = database().transaction(async tx => {
        if (selectedId !== undefined) {
          const [owner] = await tx.select({ id: customerUsers.id }).from(customerUsers)
            .where(selectedCustomer(eq(customerUsers.email, identifier), selectedId)).for("share");
          if (!owner) throw new CustomerIdentitySelectionDenied();
        }
        if (enrollment) {
          const [owner] = await tx.select({ id: customerUsers.id }).from(customerUsers).where(eq(customerUsers.email, identifier)).for("share");
          if (owner) throw new CustomerIdentitySelectionDenied();
        }
        await tx.insert(customerVerificationTokens).values({ identifier, token, expires }).onConflictDoNothing();
        const [persisted] = await tx.select().from(customerVerificationTokens).where(eq(customerVerificationTokens.token, token)).for("share");
        requireReceipt(persisted && persisted.identifier === identifier && persisted.expires <= expires && (expires <= instant || persisted.expires > instant));
        return persisted;
      });
      scope.set(input.token, { identifier, expiresAt: input.expires.getTime(), result });
      return result;
    },
    async useVerificationToken({ identifier, token }) {
      assertCustomerWriterContext();
      const selectedId = currentWriterIdentityCustomerId();
      const enrollment = currentWriterIdentityEnrollment();
      let normalized: string;
      try { normalized = normalizeCustomerEmail(identifier); }
      catch (error) { if (selectedId !== undefined || enrollment) return null; throw error; }
      if (enrollment && (enrollment.provider !== "resend" || normalized !== identifier || !matchesWriterIdentityEnrollment(enrollment, normalized))) return null;
      const storedToken = enrollment ? enrollmentVerificationToken(enrollment, token) : token;
      const verification = await database().transaction(async tx => {
        if (selectedId !== undefined) {
          const [owner] = await tx.select({ id: customerUsers.id }).from(customerUsers)
            .where(selectedCustomer(eq(customerUsers.email, normalized), selectedId)).for("share");
          if (!owner) return null;
        }
        if (enrollment) {
          const [owner] = await tx.select({ id: customerUsers.id }).from(customerUsers).where(eq(customerUsers.email, normalized)).for("share");
          if (owner) return null;
        }
        const predicate = and(eq(customerVerificationTokens.identifier, normalized), eq(customerVerificationTokens.token, storedToken));
        const [existing] = await tx.select().from(customerVerificationTokens).where(predicate).for("update");
        if (!existing) return null;
        const [row] = await tx.delete(customerVerificationTokens).where(predicate).returning();
        const [remaining] = await tx.select().from(customerVerificationTokens).where(eq(customerVerificationTokens.token, storedToken));
        requireReceipt(row && row.identifier === existing.identifier && sameInstant(row.expires, existing.expires) && !remaining);
        return row.expires > now() ? row : null;
      });
      if (enrollment && verification) enrollmentAttempt().resendVerifiedEmail = normalized;
      return verification;
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
      catch (error) {
        if (!(error instanceof CustomerIdentitySelectionDenied)) markWriterOperationUncertain();
        throw error;
      }
    }];
  })) as Adapter;

  return {
    adapter: guardedAdapter,
    async hasLiveSession(sessionToken: string): Promise<boolean> {
      return !!await findLiveSession(sessionToken);
    },
    async isEnrollmentAvailable(email: string): Promise<boolean> {
      const enrollment = currentWriterIdentityEnrollment();
      return !!enrollment && matchesWriterIdentityEnrollment(enrollment, email) && !await findUser(eq(customerUsers.email, email));
    },
    async authorizeEnrollment(proof: EnrollmentProof): Promise<boolean> {
      const enrollment = currentWriterIdentityEnrollment();
      if (!enrollment || enrollment.provider !== proof.provider || !matchesWriterIdentityEnrollment(enrollment, proof.email)) return false;
      const attempt = enrollmentAttempt();
      if (attempt.proof || await findUser(eq(customerUsers.email, proof.email))) return false;
      if (proof.provider === "google") {
        if (!proof.subject || proof.subject.length > 255 || await adapter.getUserByAccount!({ provider: "google", providerAccountId: proof.subject })) return false;
      } else if (attempt.resendVerifiedEmail !== proof.email) return false;
      attempt.proof = proof;
      return true;
    },
    async isActive(email: string): Promise<boolean> {
      const selectedId = currentWriterIdentityCustomerId();
      const user = await findUser(eq(customerUsers.email, normalizeCustomerEmail(email)), selectedId);
      return selectedId === undefined ? !user || user.status === "active" : user !== null;
    },
    async consumeThrottle(key: string, limit: number, windowSeconds: number): Promise<boolean> {
      assertCustomerWriterContext();
      try {
        return await database().transaction(async tx => {
          const instant = now();
          // Each indexed cleanup is bounded; one login cannot inherit an arbitrary
          // maintenance backlog. No request allocates more than its fixed buckets.
          if (currentWriterIdentityCustomerId() === undefined && !currentWriterIdentityEnrollment()) {
            await tx.delete(customerAuthThrottle).where(and(lt(customerAuthThrottle.resetsAt, instant), inArray(customerAuthThrottle.key,
              tx.select({ key: customerAuthThrottle.key }).from(customerAuthThrottle).where(lt(customerAuthThrottle.resetsAt, instant)).orderBy(customerAuthThrottle.resetsAt).limit(100))));
            await tx.delete(customerVerificationTokens).where(and(lt(customerVerificationTokens.expires, instant), inArray(customerVerificationTokens.token,
              tx.select({ token: customerVerificationTokens.token }).from(customerVerificationTokens).where(lt(customerVerificationTokens.expires, instant)).orderBy(customerVerificationTokens.expires).limit(100))));
            await tx.delete(customerSessions).where(and(lt(customerSessions.expires, instant), inArray(customerSessions.tokenHash,
              tx.select({ tokenHash: customerSessions.tokenHash }).from(customerSessions).where(lt(customerSessions.expires, instant)).orderBy(customerSessions.expires).limit(100))));
          }
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
