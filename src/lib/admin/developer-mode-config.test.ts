import assert from "node:assert/strict";
import test from "node:test";

import {
  createAdminDeveloperActor,
  isAdminDeveloperModeEnabled,
  parseAdminDeveloperSession,
  serializeAdminDeveloperSession,
} from "./developer-mode-config";

const USER_ID = "4d68f682-90ab-4cdb-8f59-67f7f9414df1";
const ACCESS_KEY = "developer-access-key-with-more-than-32-characters";

test("admin developer mode is available across deployments only with an explicit flag and strong access key", () => {
  for (const environment of [
    { NODE_ENV: "development" },
    { NODE_ENV: "production", VERCEL_ENV: "preview" },
    { NODE_ENV: "production", VERCEL_ENV: "production" },
  ]) {
    assert.equal(
      isAdminDeveloperModeEnabled({
        ADMIN_DEVELOPER_ACCESS_KEY: ACCESS_KEY,
        ADMIN_DEVELOPER_MODE: "true",
        ...environment,
      }),
      true,
    );
  }
  assert.equal(
    isAdminDeveloperModeEnabled({
      ADMIN_DEVELOPER_ACCESS_KEY: ACCESS_KEY,
      ADMIN_DEVELOPER_MODE: "false",
    }),
    false,
  );
  assert.equal(
    isAdminDeveloperModeEnabled({
      ADMIN_DEVELOPER_MODE: "true",
    }),
    false,
  );
  assert.equal(
    isAdminDeveloperModeEnabled({
      ADMIN_DEVELOPER_ACCESS_KEY: "too-short",
      ADMIN_DEVELOPER_MODE: "true",
    }),
    false,
  );
});

test("admin developer sessions accept only a UUID and a known permission role", () => {
  for (const permissionRole of ["owner", "admin", "employee"] as const) {
    const session = { actingAdminUserId: USER_ID, permissionRole };
    assert.equal(
      serializeAdminDeveloperSession(session),
      `${USER_ID}.${permissionRole}`,
    );
    assert.deepEqual(
      parseAdminDeveloperSession(`${USER_ID}.${permissionRole}`),
      session,
    );
  }

  assert.equal(parseAdminDeveloperSession(undefined), null);
  assert.equal(parseAdminDeveloperSession("not-a-user.owner"), null);
  assert.equal(parseAdminDeveloperSession(`${USER_ID}.superuser`), null);
  assert.equal(parseAdminDeveloperSession(`${USER_ID}.owner.extra`), null);
});

test("developer actors preserve the represented account while replacing only its effective role", () => {
  const actor = createAdminDeveloperActor({
    bookingProviderResourceIds: ["provider-resource"],
    bookingResourceIds: ["booking-resource"],
    session: {
      actingAdminUserId: USER_ID,
      permissionRole: "owner",
    },
    user: {
      displayName: "Disabled contractor",
      email: "contractor@example.com",
      emailNormalized: "contractor@example.com",
      id: USER_ID,
      providerUserId: "google-contractor",
      role: "employee",
      status: "disabled",
    },
  });

  assert.equal(actor.user.id, USER_ID);
  assert.equal(actor.user.status, "disabled");
  assert.equal(actor.user.role, "owner");
  assert.deepEqual(actor.developerMode, {
    accountRole: "employee",
    permissionRole: "owner",
  });
  assert.deepEqual(actor.bookingProviderResourceIds, ["provider-resource"]);
  assert.deepEqual(actor.bookingResourceIds, ["booking-resource"]);
});
