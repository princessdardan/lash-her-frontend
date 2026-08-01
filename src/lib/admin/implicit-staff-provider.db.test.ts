import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { createPrivateDbPoolConfig } from "@/lib/private-db/pool-config";
import {
  adminUserResources,
  adminUsers,
  bookingProviders,
  bookingResources,
} from "@/lib/private-db/schema";
import * as schema from "@/lib/private-db/schema";

import {
  createImplicitStaffProvider,
  syncImplicitStaffProviderName,
} from "./implicit-staff-provider";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const skipReason = testDatabaseUrl
  ? undefined
  : "set TEST_DATABASE_URL to run implicit staff provider DB tests";
const pool = testDatabaseUrl
  ? new Pool(createPrivateDbPoolConfig(testDatabaseUrl))
  : null;
const db = pool ? drizzle({ client: pool, schema }) : null;

after(async () => {
  await pool?.end();
});

test(
  "creating an implicit staff provider persists one linked draft provider",
  { skip: skipReason },
  async () => {
    const rollback = new Error("rollback implicit provider fixture");

    await assert.rejects(
      requireDb().transaction(async (tx) => {
        const suffix = randomUUID();
        const [user] = await tx
          .insert(adminUsers)
          .values({
            displayName: "Automatic Provider",
            email: `implicit-provider-${suffix}@example.com`,
            emailNormalized: `implicit-provider-${suffix}@example.com`,
            providerUserId: `implicit-provider-${suffix}`,
            role: "employee",
            status: "active",
          })
          .returning({ id: adminUsers.id });

        const created = await createImplicitStaffProvider(tx, {
          adminUserId: user.id,
          createdByAdminUserId: user.id,
          displayName: "Automatic Provider",
          email: `implicit-provider-${suffix}@example.com`,
        });
        await syncImplicitStaffProviderName(tx, {
          adminUserId: user.id,
          displayName: "Updated Provider Name",
          email: `implicit-provider-${suffix}@example.com`,
        });
        const [resource] = await tx
          .select()
          .from(bookingResources)
          .where(eq(bookingResources.id, created.resourceId));
        const [provider] = await tx
          .select()
          .from(bookingProviders)
          .where(eq(bookingProviders.id, created.providerId));
        const [assignment] = await tx
          .select()
          .from(adminUserResources)
          .where(eq(adminUserResources.adminUserId, user.id));

        assert.equal(resource.kind, "provider");
        assert.equal(resource.name, "Updated Provider Name");
        assert.equal(resource.status, "draft");
        assert.equal(provider.primaryResourceId, resource.id);
        assert.equal(provider.displayName, "Updated Provider Name");
        assert.equal(provider.status, "draft");
        assert.equal(assignment.bookingResourceId, resource.id);

        throw rollback;
      }),
      rollback,
    );
  },
);

function requireDb() {
  if (!db) throw new Error("Test database is unavailable");
  return db;
}
