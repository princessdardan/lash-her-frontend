import { withAdminUserWriterAdmission } from "./user-writer-admission";
import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import stagingRelease from "../../../ops/staging/first-release.json" with { type: "json" };
import {
  adminUserResources,
  adminUsers,
  bookingResources,
} from "@/lib/private-db/schema";

import {
  canBootstrapStagingOwner,
  isAllowedStagingOwner,
  stagingOwnerRequest,
} from "./staging-owner-auth";
import { AdminAuthError, type AdminIdentity, type AdminUserRecord } from "./types";
import {
  createImplicitStaffProvider,
  syncImplicitStaffProviderName,
} from "./implicit-staff-provider";

export interface AdminUserRepository {
  bindIdentity(
    input: AdminIdentity & { adminUserId: string },
  ): Promise<AdminUserRecord>;
  createBootstrapOwner(identity: AdminIdentity, options?: { requireEmpty: true }): Promise<AdminUserRecord>;
  findByEmailNormalized(
    emailNormalized: string,
  ): Promise<AdminUserRecord | null>;
  findByProviderUserId(providerUserId: string): Promise<AdminUserRecord | null>;
  listBookingProviderResourceIds(adminUserId: string): Promise<string[]>;
  listBookingResourceIds(adminUserId: string): Promise<string[]>;
  recordSignIn(
    input: AdminIdentity & { adminUserId: string },
  ): Promise<AdminUserRecord>;
}

export type AdminUserStore = AdminUserRepository;

const adminUserSelection = {
  displayName: adminUsers.displayName,
  email: adminUsers.email,
  emailNormalized: adminUsers.emailNormalized,
  id: adminUsers.id,
  providerUserId: adminUsers.providerUserId,
  role: adminUsers.role,
  status: adminUsers.status,
};

async function writeBootstrapOwner(
  identity: AdminIdentity,
  options?: { requireEmpty: true },
  mayCreate?: () => boolean,
): Promise<AdminUserRecord> {
  return getPrivateDb().transaction(async (tx) => {
    if (options?.requireEmpty) {
      // Serialize scoped first-owner materialization with all admin row writers.
      await tx.execute(sql`SET LOCAL lock_timeout = '1500ms'`);
      await tx.execute(sql`LOCK TABLE public.admin_users IN SHARE ROW EXCLUSIVE MODE`);
      const existing = await tx.select(adminUserSelection).from(adminUsers).limit(2);
      if (existing.length !== 0) {
        const [owner] = existing;
        if (existing.length === 1 && owner.role === "owner" && owner.status === "active" &&
          owner.emailNormalized === identity.email.trim().toLowerCase() && owner.providerUserId === identity.providerUserId) return owner;
        if (mayCreate) throw new AdminAuthError("forbidden");
        throw new Error("First-owner bootstrap requires an empty admin store");
      }
    }
    if (mayCreate && !mayCreate()) throw new AdminAuthError("forbidden");
    const rows = await tx
      .insert(adminUsers)
      .values({
        displayName: identity.displayName,
        email: identity.email.trim(),
        emailNormalized: identity.email.trim().toLowerCase(),
        lastSignedInAt: new Date(),
        providerUserId: identity.providerUserId,
        role: "owner",
        status: "active",
      })
      .onConflictDoNothing()
      .returning(adminUserSelection);

    if (!rows[0]) {
      throw new Error("Admin bootstrap identity already exists");
    }

    await createImplicitStaffProvider(tx, {
      adminUserId: rows[0].id,
      createdByAdminUserId: rows[0].id,
      displayName: rows[0].displayName,
      email: rows[0].email,
    });

    return rows[0];
  });
}

export function isReviewedStagingAdminDatabase(connectionString = process.env.DATABASE_URL): boolean {
  try {
    const url = new URL(connectionString ?? "");
    const expected = stagingRelease.frontendDatabase;
    const keys = [...url.searchParams.keys()];
    return ["postgres:", "postgresql:"].includes(url.protocol) &&
      [expected.pooledHost, expected.directHost].includes(url.hostname) &&
      (url.port || "5432") === "5432" &&
      decodeURIComponent(url.pathname) === `/${expected.database}` &&
      decodeURIComponent(url.username) === expected.runtimeRole && !!url.password && !url.hash &&
      url.searchParams.getAll("sslmode").length === 1 && url.searchParams.get("sslmode") === "verify-full" &&
      (keys.length === 1 || keys.length === 2 && ["require", "prefer"].includes(url.searchParams.get("channel_binding") ?? ""));
  } catch {
    return false;
  }
}

export async function createStagingFirstOwner(identity: AdminIdentity): Promise<AdminUserRecord> {
  if (
    identity.emailVerified !== true ||
    !/^[!-~]{1,255}$/u.test(identity.providerUserId) ||
    !isAllowedStagingOwner(identity.email) ||
    !await stagingOwnerRequest() ||
    !isReviewedStagingAdminDatabase() ||
    !canBootstrapStagingOwner()
  ) throw new AdminAuthError("forbidden");

  // This callback-only write uses the existing empty-store bootstrap
  // transaction. Recheck the authorized time window after taking its lock.
  return writeBootstrapOwner(identity, { requireEmpty: true }, canBootstrapStagingOwner);
}

export function createDrizzleAdminUserRepository(): AdminUserRepository {
  const db = getPrivateDb();

  return withAdminUserWriterAdmission({
    async bindIdentity(input) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(adminUsers)
          .set({
            displayName: input.displayName,
            email: input.email.trim(),
            emailNormalized: input.email.trim().toLowerCase(),
            lastSignedInAt: new Date(),
            providerUserId: input.providerUserId,
            updatedAt: new Date(),
          })
          .where(eq(adminUsers.id, input.adminUserId))
          .returning(adminUserSelection);

        if (!rows[0]) {
          throw new Error("Admin user disappeared while binding identity");
        }
        await syncImplicitStaffProviderName(tx, {
          adminUserId: rows[0].id,
          displayName: rows[0].displayName,
          email: rows[0].email,
        });

        return rows[0];
      });
    },
    createBootstrapOwner: writeBootstrapOwner,
    async findByEmailNormalized(emailNormalized) {
      const rows = await db
        .select(adminUserSelection)
        .from(adminUsers)
        .where(eq(adminUsers.emailNormalized, emailNormalized))
        .limit(1);

      return rows[0] ?? null;
    },
    async findByProviderUserId(providerUserId) {
      const rows = await db
        .select(adminUserSelection)
        .from(adminUsers)
        .where(eq(adminUsers.providerUserId, providerUserId))
        .limit(1);

      return rows[0] ?? null;
    },
    async listBookingProviderResourceIds(adminUserId) {
      const rows = await db
        .select({ bookingResourceId: adminUserResources.bookingResourceId })
        .from(adminUserResources)
        .innerJoin(
          bookingResources,
          eq(bookingResources.id, adminUserResources.bookingResourceId),
        )
        .where(
          and(
            eq(adminUserResources.adminUserId, adminUserId),
            eq(bookingResources.kind, "provider"),
          ),
        );

      return rows.map((row) => row.bookingResourceId);
    },
    async listBookingResourceIds(adminUserId) {
      const rows = await db
        .select({ bookingResourceId: adminUserResources.bookingResourceId })
        .from(adminUserResources)
        .innerJoin(
          bookingResources,
          eq(bookingResources.id, adminUserResources.bookingResourceId),
        )
        .where(
          and(
            eq(adminUserResources.adminUserId, adminUserId),
            eq(bookingResources.kind, "provider"),
          ),
        );

      return rows.map((row) => row.bookingResourceId);
    },
    async recordSignIn(input) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(adminUsers)
          .set({
            displayName: input.displayName,
            email: input.email.trim(),
            emailNormalized: input.email.trim().toLowerCase(),
            lastSignedInAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(adminUsers.id, input.adminUserId))
          .returning(adminUserSelection);

        if (!rows[0]) {
          throw new Error("Admin user disappeared while refreshing identity");
        }
        await syncImplicitStaffProviderName(tx, {
          adminUserId: rows[0].id,
          displayName: rows[0].displayName,
          email: rows[0].email,
        });

        return rows[0];
      });
    },
  });
}

export function getAdminUserStore(): AdminUserStore {
  return createDrizzleAdminUserRepository();
}

export async function findAdminUserById(
  adminUserId: string,
): Promise<AdminUserRecord | null> {
  const rows = await getPrivateDb()
    .select(adminUserSelection)
    .from(adminUsers)
    .where(eq(adminUsers.id, adminUserId))
    .limit(1);

  return rows[0] ?? null;
}

export async function listAdminUsersForDeveloperMode(): Promise<
  Array<
    Pick<AdminUserRecord, "displayName" | "email" | "id" | "role" | "status">
  >
> {
  return getPrivateDb()
    .select({
      displayName: adminUsers.displayName,
      email: adminUsers.email,
      id: adminUsers.id,
      role: adminUsers.role,
      status: adminUsers.status,
    })
    .from(adminUsers)
    .orderBy(asc(adminUsers.displayName), asc(adminUsers.emailNormalized));
}
