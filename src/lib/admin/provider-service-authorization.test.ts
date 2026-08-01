import assert from "node:assert/strict";
import test from "node:test";

import {
  assertProviderOwnedServiceAccess,
  assertProviderOfferingAccess,
  assertProviderResourceAccess,
  canAccessProviderResource,
  hasGlobalProviderServiceAccess,
} from "./provider-service-authorization";
import { AdminAuthError, type AdminActor } from "./types";

function actor(
  role: AdminActor["user"]["role"],
  bookingProviderResourceIds: string[] = [],
): AdminActor {
  return {
    bookingProviderResourceIds,
    bookingResourceIds: bookingProviderResourceIds,
    user: {
      displayName: null,
      email: "staff@example.com",
      emailNormalized: "staff@example.com",
      id: "user-1",
      providerUserId: "provider-user-1",
      role,
      status: "active",
    },
  };
}

test("owners and administrators have global provider service access", () => {
  for (const role of ["owner", "admin"] as const) {
    const adminActor = actor(role);
    assert.equal(hasGlobalProviderServiceAccess(adminActor), true);
    assert.equal(canAccessProviderResource(adminActor, "resource-a"), true);
    assert.doesNotThrow(() =>
      assertProviderOwnedServiceAccess(adminActor, {
        ownerProviderId: null,
        ownerProviderPrimaryResourceId: null,
      }),
    );
  }
});

test("contractors can access only assigned provider resources", () => {
  const contractor = actor("employee", ["resource-a"]);

  assert.equal(canAccessProviderResource(contractor, "resource-a"), true);
  assert.equal(canAccessProviderResource(contractor, "resource-b"), false);
  assert.doesNotThrow(() =>
    assertProviderResourceAccess(contractor, "resource-a"),
  );
  assert.throws(
    () => assertProviderResourceAccess(contractor, "resource-b"),
    (error) => error instanceof AdminAuthError && error.code === "forbidden",
  );
});

test("contractors cannot mutate shared or another provider's service", () => {
  const contractor = actor("employee", ["resource-a"]);

  assert.doesNotThrow(() =>
    assertProviderOwnedServiceAccess(contractor, {
      ownerProviderId: "provider-a",
      ownerProviderPrimaryResourceId: "resource-a",
      targetProviderId: "provider-a",
    }),
  );

  for (const input of [
    {
      ownerProviderId: null,
      ownerProviderPrimaryResourceId: null,
      targetProviderId: "provider-a",
    },
    {
      ownerProviderId: "provider-b",
      ownerProviderPrimaryResourceId: "resource-b",
      targetProviderId: "provider-b",
    },
    {
      ownerProviderId: "provider-a",
      ownerProviderPrimaryResourceId: "resource-a",
      targetProviderId: "provider-b",
    },
  ]) {
    assert.throws(
      () => assertProviderOwnedServiceAccess(contractor, input),
      (error) => error instanceof AdminAuthError && error.code === "forbidden",
    );
  }
});

test("contractors can manage their offering on a shared or matching owned service", () => {
  const contractor = actor("employee", ["resource-a"]);

  for (const ownerProviderId of [null, "provider-a"]) {
    assert.doesNotThrow(() =>
      assertProviderOfferingAccess(contractor, {
        ownerProviderId,
        providerId: "provider-a",
        providerPrimaryResourceId: "resource-a",
      }),
    );
  }

  assert.throws(
    () =>
      assertProviderOfferingAccess(contractor, {
        ownerProviderId: "provider-b",
        providerId: "provider-a",
        providerPrimaryResourceId: "resource-a",
      }),
    (error) => error instanceof AdminAuthError && error.code === "forbidden",
  );
  assert.throws(
    () =>
      assertProviderOfferingAccess(contractor, {
        ownerProviderId: null,
        providerId: "provider-b",
        providerPrimaryResourceId: "resource-b",
      }),
    (error) => error instanceof AdminAuthError && error.code === "forbidden",
  );
});
