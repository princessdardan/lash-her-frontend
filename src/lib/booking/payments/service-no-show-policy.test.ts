import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  SERVICE_NO_SHOW_POLICY_TEXT,
  SERVICE_NO_SHOW_POLICY_VERSION,
  buildServiceNoShowPolicyAcceptance,
  calculateServiceNoShowMaxChargeCents,
  getCanonicalServiceNoShowPolicyEvidence,
  hashServiceNoShowAuditValue,
  hashServiceNoShowPolicyText,
  normalizeServiceNoShowPolicyText,
} from "./service-no-show-policy";

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

test("SERVICE_NO_SHOW_POLICY_VERSION is stable", () => {
  assert.equal(
    SERVICE_NO_SHOW_POLICY_VERSION,
    "service-no-show-full-amount-v1",
  );
});

test("normalizeServiceNoShowPolicyText trims and collapses whitespace", () => {
  const raw = "  No-show  policy\t\n  text  ";
  const normalized = normalizeServiceNoShowPolicyText(raw);
  assert.equal(normalized, "no-show policy text");
});

test("hashServiceNoShowPolicyText returns sha256 hex of normalized text", () => {
  const raw = "  No-show  policy\t\n  text  ";
  const hash = hashServiceNoShowPolicyText(raw);
  const expected = sha256Hex("no-show policy text");
  assert.equal(hash, expected);
});

test("hashServiceNoShowAuditValue hashes a value and returns undefined for undefined", () => {
  const value = "192.168.1.1";
  assert.equal(hashServiceNoShowAuditValue(value), sha256Hex(value));
  assert.equal(hashServiceNoShowAuditValue(undefined), undefined);
});

test("calculateServiceNoShowMaxChargeCents sums service and add-on amounts", () => {
  assert.equal(
    calculateServiceNoShowMaxChargeCents({
      serviceAmountCents: 12_500,
      addOnAmountCents: 2_000,
    }),
    14_500,
  );
  assert.equal(
    calculateServiceNoShowMaxChargeCents({ serviceAmountCents: 12_500 }),
    12_500,
  );
});

test("calculateServiceNoShowMaxChargeCents extracts amounts defensively from loose snapshots", () => {
  assert.equal(
    calculateServiceNoShowMaxChargeCents({
      serviceAmountCents: 10_000,
      addOnAmountCents: 1_500,
      extra: "ignored",
    } as Record<string, unknown>),
    11_500,
  );
  assert.equal(
    calculateServiceNoShowMaxChargeCents({
      serviceAmountCents: 10_000,
    } as Record<string, unknown>),
    10_000,
  );
  assert.equal(
    calculateServiceNoShowMaxChargeCents({} as Record<string, unknown>),
    0,
  );
});

test("calculateServiceNoShowMaxChargeCents reads real booking snapshot shape in dollars", () => {
  assert.equal(
    calculateServiceNoShowMaxChargeCents({
      id: "service-classic-fill",
      slug: "classic-fill",
      title: "Classic Fill",
      fullPrice: 140,
      selectedAddOn: { price: 25 },
    } as Record<string, unknown>),
    16_500,
  );
  assert.equal(
    calculateServiceNoShowMaxChargeCents({
      fullPrice: 140,
    } as Record<string, unknown>),
    14_000,
  );
});

test("calculateServiceNoShowMaxChargeCents converts dollar amounts to cents with rounding", () => {
  assert.equal(
    calculateServiceNoShowMaxChargeCents({
      fullPrice: 139.99,
      selectedAddOn: { price: 24.99 },
    } as Record<string, unknown>),
    16_498,
  );
  assert.equal(
    calculateServiceNoShowMaxChargeCents({
      selectedAddOn: { price: 0.25 },
    } as Record<string, unknown>),
    25,
  );
});

test("calculateServiceNoShowMaxChargeCents rejects invalid cent amounts", () => {
  assert.throws(
    () =>
      calculateServiceNoShowMaxChargeCents({
        serviceAmountCents: 1000,
        addOnAmountCents: -999,
      } as Record<string, unknown>),
    /addOnAmountCents must be a positive safe integer/i,
  );
  assert.throws(
    () =>
      calculateServiceNoShowMaxChargeCents({
        serviceAmountCents: 100.5,
      } as Record<string, unknown>),
    /serviceAmountCents must be a positive safe integer/i,
  );
  assert.throws(
    () =>
      calculateServiceNoShowMaxChargeCents({
        serviceAmountCents: 0,
      } as Record<string, unknown>),
    /serviceAmountCents must be a positive safe integer/i,
  );
});

test("calculateServiceNoShowMaxChargeCents rejects negative dollar amounts", () => {
  assert.throws(
    () =>
      calculateServiceNoShowMaxChargeCents({
        fullPrice: -1,
      } as Record<string, unknown>),
    /fullPrice must be a finite non-negative number/i,
  );
  assert.throws(
    () =>
      calculateServiceNoShowMaxChargeCents({
        fullPrice: 100,
        selectedAddOn: { price: -0.5 },
      } as Record<string, unknown>),
    /selectedAddOn.price must be a finite non-negative number/i,
  );
});

test("buildServiceNoShowPolicyAcceptance rejects missing max charge amount", () => {
  assert.throws(
    () =>
      buildServiceNoShowPolicyAcceptance({
        accepted: true,
        acceptedAt: new Date("2026-06-19T12:00:00.000Z"),
        customerEmail: "client@example.com",
        customerName: "Jane Doe",
        maxChargeCents: undefined as unknown as number,
        policyText: "Policy text",
      }),
    /maxChargeCents must be a positive integer/i,
  );
});

test("buildServiceNoShowPolicyAcceptance rejects zero max charge amount", () => {
  assert.throws(
    () =>
      buildServiceNoShowPolicyAcceptance({
        accepted: true,
        acceptedAt: new Date("2026-06-19T12:00:00.000Z"),
        customerEmail: "client@example.com",
        customerName: "Jane Doe",
        maxChargeCents: 0,
        policyText: "Policy text",
      }),
    /maxChargeCents must be a positive integer/i,
  );
});

test("buildServiceNoShowPolicyAcceptance rejects negative max charge amount", () => {
  assert.throws(
    () =>
      buildServiceNoShowPolicyAcceptance({
        accepted: true,
        acceptedAt: new Date("2026-06-19T12:00:00.000Z"),
        customerEmail: "client@example.com",
        customerName: "Jane Doe",
        maxChargeCents: -100,
        policyText: "Policy text",
      }),
    /maxChargeCents must be a positive integer/i,
  );
});

test("buildServiceNoShowPolicyAcceptance returns normalized audit metadata without raw PII", () => {
  const acceptedAt = new Date("2026-06-19T12:00:00.000Z");
  const policyText = "  No-show  policy\t\n  text  ";
  const ipAddress = "192.168.1.1";
  const userAgent = "Mozilla/5.0 Test";

  const result = buildServiceNoShowPolicyAcceptance({
    accepted: true,
    acceptedAt,
    customerEmail: "client@example.com",
    customerName: "Jane Doe",
    ipAddress,
    maxChargeCents: 14_500,
    policyText,
    userAgent,
  });

  assert.equal(result.policyVersion, SERVICE_NO_SHOW_POLICY_VERSION);
  assert.equal(result.policyTextHash, hashServiceNoShowPolicyText(policyText));
  assert.equal(result.acceptedAt, acceptedAt.toISOString());
  assert.equal(result.maxChargeCents, 14_500);
  assert.equal(result.currency, "CAD");
  assert.equal(result.customerEmail, "client@example.com");
  assert.equal(result.customerName, "Jane Doe");
  assert.equal(result.ipAddressHash, sha256Hex(ipAddress));
  assert.equal(result.userAgentHash, sha256Hex(userAgent));
  assert.equal("ipAddress" in result, false);
  assert.equal("userAgent" in result, false);
});

test("getCanonicalServiceNoShowPolicyEvidence uses server policy text and version", () => {
  const acceptedAt = new Date("2026-06-19T12:00:00.000Z");
  const ipAddress = "192.168.1.1";
  const userAgent = "Mozilla/5.0 Test";

  const result = getCanonicalServiceNoShowPolicyEvidence({
    acceptedAt,
    customerEmail: "client@example.com",
    customerName: "Jane Doe",
    ipAddress,
    maxChargeCents: 14_500,
    userAgent,
  });

  assert.equal(result.accepted, true);
  assert.equal(result.policyVersion, SERVICE_NO_SHOW_POLICY_VERSION);
  assert.equal(
    result.policyTextHash,
    hashServiceNoShowPolicyText(SERVICE_NO_SHOW_POLICY_TEXT),
  );
  assert.equal(result.maxChargeCents, 14_500);
  assert.equal(result.ipAddressHash, sha256Hex(ipAddress));
  assert.equal(result.userAgentHash, sha256Hex(userAgent));
});

test("SERVICE_NO_SHOW_POLICY_TEXT does not say no payment will be taken today", () => {
  assert.equal(
    /No payment will be taken today/i.test(SERVICE_NO_SHOW_POLICY_TEXT),
    false,
  );
});

test("SERVICE_NO_SHOW_POLICY_TEXT states today's booking payment is charged and card is stored", () => {
  assert.match(SERVICE_NO_SHOW_POLICY_TEXT, /today['’]s booking payment/i);
  assert.match(SERVICE_NO_SHOW_POLICY_TEXT, /charge/i);
  assert.match(SERVICE_NO_SHOW_POLICY_TEXT, /store/i);
});

test("getCanonicalServiceNoShowPolicyEvidence omits hashes when IP/UA are absent", () => {
  const result = getCanonicalServiceNoShowPolicyEvidence({
    acceptedAt: new Date("2026-06-19T12:00:00.000Z"),
    customerEmail: "client@example.com",
    customerName: "Jane Doe",
    maxChargeCents: 10_000,
  });

  assert.equal(result.ipAddressHash, undefined);
  assert.equal(result.userAgentHash, undefined);
});
