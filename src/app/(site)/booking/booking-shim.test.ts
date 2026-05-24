import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { resolveBookingShim } from "./booking-shim";

const bookingPageSource = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

test("booking shim renders canonical booking for empty and in-person-only links", async () => {
  assert.deepEqual(await resolveBookingShim({}, createDependencies()), { kind: "render" });
  assert.deepEqual(
    await resolveBookingShim({ type: "in-person-appointment" }, createDependencies()),
    { kind: "render" },
  );
});

test("booking shim rejects malformed, private, training, and unknown legacy URLs", async () => {
  for (const searchParams of [
    { offering: ["lash-fill"] as unknown as string },
    { email: "client@example.com" },
    { token: "legacy-token-123" },
    { order: "lh-order-123" },
    { paidSchedulingToken: "legacy-token-123" },
    { type: "training-call" },
    { type: "not-a-booking-type" },
  ]) {
    assert.deepEqual(await resolveBookingShim(searchParams, createDependencies()), { kind: "notFound" });
  }
});

test("booking shim rejects conflicting service aliases", async () => {
  assert.deepEqual(
    await resolveBookingShim(
      { offering: "lash-fill", offeringSlug: "classic-fill" },
      createDependencies({ service: { slug: "lash-fill" } }),
    ),
    { kind: "notFound" },
  );
});

test("booking shim permanently redirects accepted service legacy links", async () => {
  for (const searchParams of [
    { offeringSlug: "lash-fill" },
    { offering: "lash-fill" },
    { serviceSlug: "lash-fill" },
    { service: "lash-fill" },
  ]) {
    assert.deepEqual(
      await resolveBookingShim(searchParams, createDependencies({ service: { slug: "lash-fill" } })),
      {
        kind: "redirect",
        href: "/services/lash-fill/booking",
        redirectMode: "permanent",
      },
    );
  }
});

test("booking page disables static caching and only uses permanent service redirects", () => {
  assert.match(bookingPageSource, /export const dynamic = "force-dynamic";/);
  assert.match(bookingPageSource, /export const revalidate = 0;/);
  assert.match(bookingPageSource, /permanentRedirect\(resolution\.href\)/);
  assert.doesNotMatch(bookingPageSource, /redirect\(resolution\.href\)/);
  assert.doesNotMatch(bookingPageSource, /findPendingTrainingEnrollmentByToken|getOrIssueTrainingSchedulingTokenForPaidOrder/);
});

function createDependencies(overrides: { service?: { slug: string } | null } = {}) {
  return {
    getBookableServiceBySlug: async (slug: string) => {
      if (overrides.service?.slug === slug) {
        return { slug } as never;
      }

      return null;
    },
  };
}
