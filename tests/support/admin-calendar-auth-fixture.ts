import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { encode } from "next-auth/jwt";
import { Pool, type PoolClient } from "pg";

import { createPrivateDbPoolConfig } from "../../src/lib/private-db/pool-config";
import {
  ADMIN_CALENDAR_E2E_AUTH_SECRET,
  getAdminCalendarE2EDatabaseUrl,
} from "./admin-calendar-e2e-config";

const SESSION_COOKIE_NAME = "authjs.session-token";

interface BrowserStorageState {
  cookies: Array<{
    domain: string;
    expires: number;
    httpOnly: boolean;
    name: string;
    path: string;
    sameSite: "Lax";
    secure: boolean;
    value: string;
  }>;
  origins: [];
}

export interface AdminCalendarAuthFixture {
  cleanup(): Promise<void>;
  employeeConnectionEmail: string;
  employeeStorageState: BrowserStorageState;
  expectedRefreshToken: string;
  loadPersistedCredential(): Promise<{
    credentialCiphertext: string | null;
    credentialSecretRef: string | null;
    status: string;
  }>;
  persistOAuthState(state: string): Promise<void>;
  oauthCode: string;
  ownerStorageState: BrowserStorageState;
  resourceName: string;
}

export async function createAdminCalendarAuthFixture(): Promise<AdminCalendarAuthFixture> {
  const databaseUrl = getAdminCalendarE2EDatabaseUrl();
  if (databaseUrl === null) {
    throw new Error(
      "TEST_DATABASE_URL is required for the deterministic admin calendar browser fixture",
    );
  }

  const runId = randomUUID().replaceAll("-", "");
  const ids = {
    employee: randomUUID(),
    employeeResource: randomUUID(),
    owner: randomUUID(),
    provider: randomUUID(),
    resource: randomUUID(),
  };
  const ownerIdentity = {
    email: `owner-${runId}@example.test`,
    name: "Calendar E2E Owner",
    providerUserId: `e2e-owner-${runId}`,
  };
  const employeeIdentity = {
    email: `employee-${runId}@example.test`,
    name: "Calendar E2E Employee",
    providerUserId: `e2e-employee-${runId}`,
  };
  const resourceName = `Calendar E2E Provider ${runId.slice(0, 8)}`;
  const employeeConnectionEmail = `calendar-${runId}@example.test`;
  const [employeeStorageState, ownerStorageState] = await Promise.all([
    createStorageState(employeeIdentity),
    createStorageState(ownerIdentity),
  ]);
  const pool = new Pool(createPrivateDbPoolConfig(databaseUrl));
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    await pool.end();
    throw error;
  }
  let seeded = false;

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO admin_users (
        id, provider_user_id, email, email_normalized, display_name, role, status
      ) VALUES
        ($1, $2, $3, $3, $4, 'owner', 'active'),
        ($5, $6, $7, $7, $8, 'employee', 'active')`,
      [
        ids.owner,
        ownerIdentity.providerUserId,
        ownerIdentity.email,
        ownerIdentity.name,
        ids.employee,
        employeeIdentity.providerUserId,
        employeeIdentity.email,
        employeeIdentity.name,
      ],
    );
    await client.query(
      `INSERT INTO booking_resources (
        id, resource_key, name, kind, timezone, status, created_by_admin_user_id
      ) VALUES ($1, $2, $3, 'provider', 'America/Toronto', 'active', $4)`,
      [ids.resource, `calendar-e2e-resource-${runId}`, resourceName, ids.owner],
    );
    await client.query(
      `INSERT INTO booking_providers (
        id, provider_key, display_name, primary_resource_id, status,
        created_by_admin_user_id
      ) VALUES ($1, $2, $3, $4, 'active', $5)`,
      [
        ids.provider,
        `calendar-e2e-provider-${runId}`,
        resourceName,
        ids.resource,
        ids.owner,
      ],
    );
    await client.query(
      `INSERT INTO admin_user_resources (
        id, admin_user_id, booking_resource_id, created_by_admin_user_id
      ) VALUES ($1, $2, $3, $4)`,
      [ids.employeeResource, ids.employee, ids.resource, ids.owner],
    );
    await client.query("COMMIT");
    seeded = true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    if (!seeded) {
      await pool.end();
    }
  }

  return {
    async cleanup() {
      const cleanupClient = await pool.connect();
      try {
        await cleanupClient.query("BEGIN");
        await cleanupClient.query(
          `DELETE FROM admin_audit_logs
           WHERE actor_admin_user_id = ANY($1::uuid[])`,
          [[ids.owner, ids.employee]],
        );
        await cleanupClient.query(
          `DELETE FROM booking_resource_calendar_assignments
           WHERE resource_id = $1`,
          [ids.resource],
        );
        await cleanupClient.query(
          `DELETE FROM booking_calendar_connections
           WHERE connected_by_admin_user_id = ANY($1::uuid[])
              OR credential_owner_admin_user_id = ANY($1::uuid[])`,
          [[ids.owner, ids.employee]],
        );
        await cleanupClient.query(
          "DELETE FROM admin_user_resources WHERE booking_resource_id = $1",
          [ids.resource],
        );
        await cleanupClient.query(
          "DELETE FROM booking_providers WHERE id = $1",
          [ids.provider],
        );
        await cleanupClient.query(
          "DELETE FROM booking_resources WHERE id = $1",
          [ids.resource],
        );
        await cleanupClient.query(
          "DELETE FROM admin_users WHERE id = ANY($1::uuid[])",
          [[ids.owner, ids.employee]],
        );
        await cleanupClient.query("COMMIT");
      } catch (error) {
        await cleanupClient.query("ROLLBACK");
        throw error;
      } finally {
        cleanupClient.release();
        await pool.end();
      }
    },
    employeeConnectionEmail,
    employeeStorageState,
    expectedRefreshToken: `e2e-calendar-refresh-${runId}`,
    async loadPersistedCredential() {
      const result = await pool.query<{
        credential_ciphertext: string | null;
        credential_secret_ref: string | null;
        status: string;
      }>(
        `SELECT credential_ciphertext, credential_secret_ref, status
         FROM booking_calendar_connections
         WHERE credential_owner_admin_user_id = $1
           AND account_email = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [ids.employee, employeeConnectionEmail],
      );
      const connection = result.rows[0];
      if (!connection) {
        throw new Error("The employee calendar connection was not persisted");
      }

      return {
        credentialCiphertext: connection.credential_ciphertext,
        credentialSecretRef: connection.credential_secret_ref,
        status: connection.status,
      };
    },
    async persistOAuthState(state) {
      if (!/^[A-Za-z0-9_-]{20,128}$/.test(state)) {
        throw new Error("Invalid browser fixture OAuth state");
      }
      const [connection] = await pool
        .query<{ id: string }>(
          `SELECT id
         FROM booking_calendar_connections
         WHERE credential_owner_admin_user_id = $1
           AND status = 'reconnect_required'
         ORDER BY created_at DESC
         LIMIT 1`,
          [ids.employee],
        )
        .then((result) => result.rows);
      if (!connection) {
        throw new Error(
          "The provisional employee calendar connection was not created",
        );
      }

      const directory = join(
        process.cwd(),
        "test-results",
        "calendar-oauth-state",
      );
      const key = `booking:calendar-oauth-state:${state}`;
      const filename = `${createHash("sha256").update(key).digest("hex")}.json`;
      await mkdir(directory, { mode: 0o700, recursive: true });
      await writeFile(
        join(directory, filename),
        JSON.stringify({
          expiresAt: Date.now() + 10 * 60 * 1000,
          value: JSON.stringify({
            actorAdminUserId: ids.employee,
            connectionId: connection.id,
            flowType: "employee",
            resourceId: ids.resource,
            returnTo: "/admin/my-calendar",
          }),
        }),
        { encoding: "utf8", mode: 0o600 },
      );
    },
    oauthCode: `e2e-calendar-${runId}`,
    ownerStorageState,
    resourceName,
  };
}

async function createStorageState(identity: {
  email: string;
  name: string;
  providerUserId: string;
}): Promise<BrowserStorageState> {
  const maxAge = 8 * 60 * 60;
  const value = await encode({
    maxAge,
    salt: SESSION_COOKIE_NAME,
    secret: ADMIN_CALENDAR_E2E_AUTH_SECRET,
    token: {
      email: identity.email,
      googleEmailVerified: true,
      name: identity.name,
      providerUserId: identity.providerUserId,
      sub: identity.providerUserId,
    },
  });

  return {
    cookies: [
      {
        domain: "localhost",
        expires: Math.floor(Date.now() / 1000) + maxAge,
        httpOnly: true,
        name: SESSION_COOKIE_NAME,
        path: "/",
        sameSite: "Lax",
        secure: false,
        value,
      },
    ],
    origins: [],
  };
}
