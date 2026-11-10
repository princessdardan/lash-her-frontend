import assert from "node:assert/strict";
import test from "node:test";
import {
  attemptAdmittedAdminAction,
  ADMIN_WRITER_UNAVAILABLE,
} from "@/lib/admin/action-admission";
import {
  handleAdminCalendarOAuthCallback,
  type AdminCalendarOAuthCallbackDependencies,
} from "@/lib/admin/admin-calendar-oauth-callback";
import { interactiveAdmissionFixture } from "./interactive-fixture";
import { withWriterAdmission } from "./route";
import { settleWriterEffects } from "./settle";

const state = {
  actorAdminUserId: "owned-admin",
  connectionId: "owned-connection",
  flowType: "admin" as const,
  resourceId: null,
  returnTo: "/admin/calendar-connections",
};
function callbackDependencies(
  overrides: Partial<AdminCalendarOAuthCallbackDependencies> = {},
): AdminCalendarOAuthCallbackDependencies {
  return {
    consumeState: async () => state,
    authorizeActor: async () => ({ user: { id: state.actorAdminUserId } }),
    assertEmployeeOwnsConnection: async () => {},
    exchangeCode: async () => ({
      refreshToken: "owned-token",
      scopes: [],
      getVerifiedProfile: async () => ({
        verified: true,
        providerAccountId: "owned-provider",
        accountEmail: "owned@example.invalid",
      }),
    }),
    saveOwnerCredential: async () => ({
      status: "saved",
      connectionId: state.connectionId,
    }),
    saveEmployeeCredential: async () => ({
      status: "saved",
      connectionId: state.connectionId,
    }),
    disableProvisionalConnection: async () => {},
    canRevokeRejectedGrant: async () => true,
    revokeRefreshToken: async () => {},
    ...overrides,
  };
}
const input = {
  code: "owned-code",
  origin: "https://owned.invalid",
  state: "owned-state",
};

test("admin mutation boundary refuses before authorization effects and settles before redirect control flow", async () => {
  const f = interactiveAdmissionFixture();
  f.state.open = false;
  let effects = 0;
  assert.deepEqual(
    await attemptAdmittedAdminAction(
      async () => {
        effects++;
      },
      () => "original",
      f.run,
    ),
    { ok: false, error: ADMIN_WRITER_UNAVAILABLE },
  );
  assert.equal(effects, 0);
  f.state.open = true;
  const outcome = await attemptAdmittedAdminAction(
    async () => {
      assert.equal(f.events[0], "admitted");
      effects++;
      return "owned-redirect";
    },
    () => "original",
    f.run,
  );
  assert.deepEqual(outcome, { ok: true, value: "owned-redirect" });
  assert.equal(f.state.finished, true);
  assert.equal(f.state.uncertain, false);
});

test("caught admin mutation errors do not complete admission or expose internal errors", async () => {
  const f = interactiveAdmissionFixture();
  const outcome = await attemptAdmittedAdminAction(
    async () => {
      throw new Error("owned-private-marker");
    },
    () => "original",
    f.run,
  );
  assert.deepEqual(outcome, { ok: false, error: ADMIN_WRITER_UNAVAILABLE });
  assert.equal(f.state.uncertain, true);
});

test("provider and database sibling failures do not settle before remaining effects finish", async () => {
  const f = interactiveAdmissionFixture();
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = attemptAdmittedAdminAction(
    async () =>
      settleWriterEffects([
        Promise.reject(new Error("owned-private-marker")),
        (async () => {
          entered();
          await held;
          f.events.push("sibling-finished");
        })(),
      ]),
    () => "original",
    f.run,
  );
  await started;
  assert.equal(f.state.finished, false);
  release();
  assert.equal((await pending).ok, false);
  assert.equal(f.state.uncertain, true);
  assert.deepEqual(f.events, ["admitted", "sibling-finished", "settled"]);
});

test("closed OAuth recovery refuses state consumption, provider exchange and credentials", async () => {
  const f = interactiveAdmissionFixture();
  f.state.open = false;
  let consumed = 0;
  const response = await withWriterAdmission(
    "recovery",
    () =>
      handleAdminCalendarOAuthCallback(
        input,
        callbackDependencies({
          consumeState: async () => {
            consumed++;
            return state;
          },
        }),
      ),
    f.run,
  )();
  assert.equal(response.status, 503);
  assert.equal(consumed, 0);
});

test("successful OAuth callback stores credentials after admission and cleanly returns its redirect", async () => {
  const f = interactiveAdmissionFixture();
  const response = await withWriterAdmission(
    "recovery",
    () =>
      handleAdminCalendarOAuthCallback(
        input,
        callbackDependencies({
          saveOwnerCredential: async () => {
            assert.equal(f.events[0], "admitted");
            return { status: "saved", connectionId: state.connectionId };
          },
        }),
      ),
    f.run,
  )();
  assert.equal(response.status, 307);
  assert.equal(f.state.uncertain, false);
});

test("OAuth credential/cleanup/grant-reconciliation failures cannot settle behind redirect success", async () => {
  for (const failure of [
    "save",
    "disable",
    "revoke",
    "revoke-safety",
    "account-mismatch",
    "owned-elsewhere",
  ] as const) {
    const f = interactiveAdmissionFixture();
    const fail = async () => {
      throw new Error("owned-private-marker");
    };
    const dependencies = callbackDependencies({
      saveOwnerCredential:
        failure === "account-mismatch"
          ? async () => ({
              status: "account_mismatch",
              connectionId: state.connectionId,
            })
          : failure === "owned-elsewhere"
            ? async () => ({ status: "owned_elsewhere" })
            : fail,
      ...(failure === "disable" ? { disableProvisionalConnection: fail } : {}),
      ...(failure === "revoke" ? { revokeRefreshToken: fail } : {}),
      ...(failure === "revoke-safety" ? { canRevokeRejectedGrant: fail } : {}),
    });
    const response = await withWriterAdmission(
      "recovery",
      () => handleAdminCalendarOAuthCallback(input, dependencies),
      f.run,
    )();
    assert.equal(response.status, 503, failure);
    assert.equal(f.state.uncertain, true, failure);
    assert.equal(
      (await response.text()).includes("owned-private-marker"),
      false,
    );
  }
});

test("OAuth provider denial with acknowledged cleanup settles cleanly", async () => {
  const f = interactiveAdmissionFixture();
  const response = await withWriterAdmission(
    "recovery",
    () =>
      handleAdminCalendarOAuthCallback(
        { ...input, code: null },
        callbackDependencies(),
      ),
    f.run,
  )();
  assert.equal(response.status, 307);
  assert.equal(f.state.uncertain, false);
});

test("package-profile HTTP boundary refuses before auth/write, and retains unknown transaction errors", async () => {
  const { createPackageProfileCreateHandler } =
    await import("@/app/api/admin/shipping/package-profiles/handler");
  const { NextRequest } = await import("next/server");
  const f = interactiveAdmissionFixture();
  let effects = 0;
  const handler = createPackageProfileCreateHandler({
    requireManage: async () => {
      effects++;
      return { user: { id: "owned" } };
    },
    requireConfiguredOwner: async () => ({}) as never,
    createDraft: async () => {
      throw new Error("owned-private-marker");
    },
  });
  const request = () =>
    new NextRequest(
      "https://owned.invalid/api/admin/shipping/package-profiles",
      {
        method: "POST",
        headers: {
          origin: "https://owned.invalid",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          slug: "owned-box",
          name: "Owned box",
          packageType: "parcel",
          rank: 1,
          lengthCm: 30,
          widthCm: 22,
          heightCm: 5,
          tareWeightGrams: 90,
          maxWeightGrams: 2000,
          acceptsRigid: true,
        }),
      },
    );
  f.state.open = false;
  const closed = request();
  assert.equal(
    (await withWriterAdmission("new-work", handler, f.run)(closed)).status,
    503,
  );
  assert.equal(closed.bodyUsed, false);
  assert.equal(effects, 0);
  f.state.open = true;
  const response = await withWriterAdmission(
    "new-work",
    handler,
    f.run,
  )(request());
  assert.equal(response.status, 503);
  assert.equal(f.state.uncertain, true);
  assert.equal((await response.text()).includes("owned-private-marker"), false);
});

test("existing label recovery waits for its entire bounded PDF download before settling admission", async () => {
  const { createShippingLabelHandler } =
    await import("@/app/api/admin/orders/[orderId]/shipping/label/handler");
  const { NextRequest } = await import("next/server");
  const f = interactiveAdmissionFixture();
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const handler = createShippingLabelHandler({
    requirePermission: async () => ({}) as never,
    getShipmentForOrderReference: async () =>
      ({ providerShipmentId: "owned-provider-shipment" }) as never,
    getChitChatsConfig: () =>
      ({ baseUrl: "https://carrier.owned.invalid" }) as never,
    createChitChatsClient: () =>
      ({
        getShipment: async () => ({
          postage_label_pdf_url:
            "https://carrier.owned.invalid/labels/shipments/owned.pdf",
        }),
      }) as never,
    fetch: async () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            entered();
            await held;
            controller.enqueue(new TextEncoder().encode("%PDF-owned"));
            controller.close();
          },
        }),
        { headers: { "content-type": "application/pdf" } },
      ),
  });
  const pending = withWriterAdmission(
    "recovery",
    handler,
    f.run,
  )(
    new NextRequest(
      "https://owned.invalid/api/admin/orders/owned/shipping/label?shipmentId=owned&expectedStateVersion=1",
    ),
    { params: Promise.resolve({ orderId: "owned" }) },
  );
  await started;
  assert.equal(f.state.finished, false);
  release();
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "%PDF-owned");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(f.state.uncertain, false);
});
