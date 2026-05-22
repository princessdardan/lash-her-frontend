import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { resolveBookingShim } from "./booking-shim";

const bookingPageSource = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

test("booking shim rejects bare and malformed legacy URLs", async () => {
  const result = await resolveBookingShim({}, createDependencies());
  assert.deepEqual(result, { kind: "notFound" });

  assert.deepEqual(
    await resolveBookingShim({ offering: ["lash-fill"] as unknown as string }, createDependencies()),
    { kind: "notFound" },
  );

  assert.deepEqual(
    await resolveBookingShim({ email: "client@example.com" }, createDependencies()),
    { kind: "notFound" },
  );

  assert.deepEqual(
    await resolveBookingShim({ offering: "lash-fill", order: "lh-order-123" }, createDependencies()),
    { kind: "notFound" },
  );

  assert.deepEqual(
    await resolveBookingShim({ token: "legacy-token-123" }, createDependencies()),
    { kind: "notFound" },
  );
});

test("booking shim rejects conflicting service aliases even when other params are valid", async () => {
  assert.deepEqual(
    await resolveBookingShim(
      { offering: "lash-fill", offeringSlug: "classic-fill", type: "training-call" },
      createDependencies({ offering: { slug: "lash-fill" } }),
    ),
    { kind: "notFound" },
  );
});

test("booking shim redirects accepted service legacy offering links", async () => {
  const result = await resolveBookingShim(
    { offeringSlug: "lash-fill" },
    createDependencies({
      offering: { slug: "lash-fill" },
    }),
  );

  assert.deepEqual(result, {
    kind: "redirect",
    href: "/services/lash-fill/booking",
    redirectMode: "permanent",
  });

  const offeringAliasResult = await resolveBookingShim(
    { offering: "lash-fill" },
    createDependencies({
      offering: { slug: "lash-fill" },
    }),
  );

  assert.deepEqual(offeringAliasResult, {
    kind: "redirect",
    href: "/services/lash-fill/booking",
    redirectMode: "permanent",
  });
});

test("booking page uses permanent redirect semantics for service legacy links and temporary semantics for training links", () => {
  assert.match(bookingPageSource, /permanentRedirect\(resolution\.href\)/);
  assert.match(bookingPageSource, /noStore\(\);/);
  assert.match(bookingPageSource, /redirect\(resolution\.href\)/);
});

test("booking shim keeps type-only training and in-person flows on the booking page", async () => {
  assert.deepEqual(
    await resolveBookingShim({ type: "training-call" }, createDependencies()),
    { kind: "render", initialBookingType: "training-call" },
  );

  assert.deepEqual(
    await resolveBookingShim({ type: "in-person-appointment" }, createDependencies()),
    { kind: "render", initialBookingType: undefined },
  );
});

test("booking shim issues a training scheduling token for order-only links", async () => {
  const result = await resolveBookingShim(
    { type: "training-call", order: "lh-order-123" },
    createDependencies({
      issuedToken: {
        checkoutEmail: "client@example.com",
        checkoutOrder: { orderId: "lh-order-123" },
        enrollmentId: "training-enrollment-1",
        productSnapshot: { id: "product-training-full" },
        programSnapshot: { slug: "lash-training" },
        schedulingToken: "schedule-token-123",
        staffAlertedAt: null,
        tokenExpiresAt: new Date("2026-05-24T00:00:00.000Z"),
      },
    }),
  );

  assert.deepEqual(result, {
    kind: "redirect",
    href: "/training-programs/lash-training/schedule?token=schedule-token-123",
    redirectMode: "temporary",
  });
});

test("booking shim rejects conflicting token aliases instead of issuing a token", async () => {
  assert.deepEqual(
    await resolveBookingShim(
      { type: "training-call", order: "lh-order-123", token: "a", schedulingToken: "b" },
      createDependencies({
        issuedToken: {
          checkoutEmail: "client@example.com",
          checkoutOrder: { orderId: "lh-order-123" },
          enrollmentId: "training-enrollment-1",
          productSnapshot: { id: "product-training-full" },
          programSnapshot: { slug: "lash-training" },
          schedulingToken: "schedule-token-123",
          staffAlertedAt: null,
          tokenExpiresAt: new Date("2026-05-24T00:00:00.000Z"),
        },
      }),
    ),
    { kind: "notFound" },
  );
});

test("booking shim resolves token-bearing training legacy links without exposing private data", async () => {
  const result = await resolveBookingShim(
    { type: "training-call", order: "lh-order-123", schedulingToken: "legacy-token-123" },
    createDependencies({
      foundByToken: {
        checkoutEmail: "client@example.com",
        checkoutOrder: { orderId: "lh-order-123" },
        enrollmentId: "training-enrollment-1",
        productSnapshot: { id: "product-training-full" },
        programSnapshot: { slug: "lash-training" },
        staffAlertedAt: null,
        tokenExpiresAt: new Date("2026-05-24T00:00:00.000Z"),
      },
    }),
  );

  assert.deepEqual(result, {
    kind: "redirect",
    href: "/training-programs/lash-training/schedule?token=legacy-token-123",
    redirectMode: "temporary",
  });
});

test("booking shim distinguishes service and training redirect modes", async () => {
  const serviceResult = await resolveBookingShim(
    { offeringSlug: "lash-fill" },
    createDependencies({ offering: { slug: "lash-fill" } }),
  );
  const trainingResult = await resolveBookingShim(
    { type: "training-call", order: "lh-order-123" },
    createDependencies({
      issuedToken: {
        checkoutEmail: "client@example.com",
        checkoutOrder: { orderId: "lh-order-123" },
        enrollmentId: "training-enrollment-1",
        productSnapshot: { id: "product-training-full" },
        programSnapshot: { slug: "lash-training" },
        schedulingToken: "schedule-token-123",
        staffAlertedAt: null,
        tokenExpiresAt: new Date("2026-05-24T00:00:00.000Z"),
      },
    }),
  );

  assert.equal(serviceResult.kind, "redirect");
  assert.equal(serviceResult.redirectMode, "permanent");
  assert.equal(trainingResult.kind, "redirect");
  assert.equal(trainingResult.redirectMode, "temporary");
});

test("booking shim rejects external and PII-bearing legacy query shapes", async () => {
  for (const searchParams of [
    { type: "training-call", order: "lh-order-123", next: "https://evil.example" },
    { type: "training-call", order: "lh-order-123", returnUrl: "https://evil.example" },
    { type: "training-call", order: "lh-order-123", name: "Client Name" },
    { type: "training-call", order: "lh-order-123", phone: "555-555-5555" },
  ]) {
    assert.deepEqual(await resolveBookingShim(searchParams, createDependencies()), { kind: "notFound" });
  }
});

function createDependencies(overrides: {
  offering?: { slug: string } | null;
  issuedToken?: {
    checkoutEmail: string;
    checkoutOrder: { orderId: string };
    enrollmentId: string;
    productSnapshot: { id: string };
    programSnapshot: { slug: string };
    schedulingToken: string;
    staffAlertedAt: null;
    tokenExpiresAt: Date;
  } | null;
  foundByToken?: {
    checkoutEmail: string;
    checkoutOrder: { orderId: string };
    enrollmentId: string;
    productSnapshot: { id: string };
    programSnapshot: { slug: string };
    staffAlertedAt: null;
    tokenExpiresAt: Date;
  } | null;
} = {}) {
  return {
    getBookingOfferingBySlug: async (slug: string) => {
      if (overrides.offering?.slug === slug) {
        return { slug } as never;
      }

      return null;
    },
    getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId: async (orderId: string) => {
      if (overrides.issuedToken?.checkoutOrder.orderId === orderId) {
        return {
          checkoutEmail: overrides.issuedToken.checkoutEmail,
          checkoutOrder: overrides.issuedToken.checkoutOrder,
          enrollmentId: overrides.issuedToken.enrollmentId,
          productSnapshot: overrides.issuedToken.productSnapshot,
          programSnapshot: overrides.issuedToken.programSnapshot,
          staffAlertedAt: overrides.issuedToken.staffAlertedAt,
          tokenExpiresAt: overrides.issuedToken.tokenExpiresAt,
        } as never;
      }

      return null;
    },
    findPendingTrainingEnrollmentByToken: async ({ schedulingToken }: { schedulingToken: string }) => {
      if (overrides.foundByToken && schedulingToken === "legacy-token-123") {
        return {
          checkoutEmail: overrides.foundByToken.checkoutEmail,
          checkoutOrder: overrides.foundByToken.checkoutOrder,
          enrollmentId: overrides.foundByToken.enrollmentId,
          productSnapshot: overrides.foundByToken.productSnapshot,
          programSnapshot: overrides.foundByToken.programSnapshot,
          staffAlertedAt: overrides.foundByToken.staffAlertedAt,
          tokenExpiresAt: overrides.foundByToken.tokenExpiresAt,
        } as never;
      }

      return null;
    },
    issueTrainingSchedulingTokenForPaidOrderIfMissing: async (orderId: string) => {
      if (overrides.issuedToken && overrides.issuedToken.checkoutOrder.orderId === orderId) {
        return overrides.issuedToken as never;
      }

      return null;
    },
  };
}
