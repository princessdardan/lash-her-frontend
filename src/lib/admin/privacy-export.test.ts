import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import type { PrivacyExportRepository } from "./privacy-export";

const actor = {
  user: {
    displayName: "Owner",
    email: "owner@example.com",
    emailNormalized: "owner@example.com",
    id: "admin-owner",
    providerUserId: "clerk-owner",
    role: "owner" as const,
    status: "active" as const,
  },
};

if (process.env.PRIVACY_EXPORT_CHILD !== "1") {
  test("privacy export test file runs under react-server conditions", () => {
    const result = spawnSync(
      process.execPath,
      ["./node_modules/.bin/tsx", "--conditions=react-server", "--test", "src/lib/admin/privacy-export.test.ts"],
      {
        cwd: process.cwd(),
        env: { ...process.env, PRIVACY_EXPORT_CHILD: "1" },
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
} else {
  async function createService(repository: PrivacyExportRepository) {
    const { createPrivacyExportService } = await import("./privacy-export");

    return createPrivacyExportService(repository);
  }

  test("privacy export requires active request and groups safe records", async () => {
  const auditEvents: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
  const repository: PrivacyExportRepository = {
    async findPrivacyRequest(id) {
      return { id, status: "open", subjectEmailNormalized: "client@example.com" };
    },
    async findSubjectRecords(emailNormalized) {
      return {
        appointmentHolds: [],
        consentEvents: [{ eventType: "opt_in", emailNormalized, occurredAt: new Date("2026-06-01T12:00:00Z") }],
        marketingContacts: [{ emailNormalized, source: "contact_popup" }],
        orders: [{ orderId: "lh-product-1", customerEmail: "client@example.com", amountCents: 4500 }],
        paymentEvents: [
          {
            amountCents: 4500,
            createdAt: new Date("2026-06-01T12:01:00Z"),
            currency: "CAD",
            eventType: "payment.paid",
            idempotencyKey: "excluded",
            message: "excluded",
            payloadHash: "excluded",
            payloadRedacted: { raw: "excluded" },
            payloadSanitized: { raw: "excluded" },
            paymentProvider: "helcim",
            processedAt: new Date("2026-06-01T12:02:00Z"),
            processingStatus: "processed",
            providerStatus: "paid",
            status: "paid",
          },
        ],
        submissions: [{ emailNormalized, source: "contact_popup", payload: { message: "Hello" } }],
        trainingEnrollments: [],
      };
    },
    async recordAuditEvent(input) {
      auditEvents.push(input);
    },
  };
  const service = await createService(repository);

  const result = await service.buildExport({
    actor,
    privacyRequestId: "privacy-1",
    reason: "Customer access request",
  });

  assert.equal(result.subjectEmailNormalized, "client@example.com");
  assert.equal(result.generatedBy, "owner@example.com");
  assert.equal(result.reason, "Customer access request");
  assert.equal(result.records.paymentEvents[0].eventType, "payment.paid");
  assert.equal(result.records.paymentEvents[0].paymentProvider, "helcim");
  assert.equal(result.records.paymentEvents[0].processedAt instanceof Date, true);
  assert.equal("payloadSanitized" in result.records.paymentEvents[0], false);
  assert.equal("payloadRedacted" in result.records.paymentEvents[0], false);
  assert.equal("payloadHash" in result.records.paymentEvents[0], false);
  assert.equal("idempotencyKey" in result.records.paymentEvents[0], false);
  assert.equal("message" in result.records.paymentEvents[0], false);
  assert.deepEqual(auditEvents.map((event) => event.action), ["privacy_export_attempt", "privacy_export_completed"]);
  assert.equal(auditEvents.some((event) => "reason" in event), false);
  });

  test("privacy export rejects inactive or missing requests", async () => {
  const statuses = ["completed", "cancelled"];

  for (const status of statuses) {
    const repository: PrivacyExportRepository = {
      async findPrivacyRequest(id) {
        return { id, status, subjectEmailNormalized: "client@example.com" };
      },
      async findSubjectRecords() {
        throw new Error("should not query records");
      },
      async recordAuditEvent() {},
    };
    const service = await createService(repository);

    await assert.rejects(
      service.buildExport({ actor, privacyRequestId: "privacy-1", reason: "Customer access request" }),
      /Privacy request is not active/,
    );
  }

  const repository: PrivacyExportRepository = {
    async findPrivacyRequest() {
      return null;
    },
    async findSubjectRecords() {
      throw new Error("should not query records");
    },
    async recordAuditEvent() {},
  };
  const service = await createService(repository);

  await assert.rejects(
    service.buildExport({ actor, privacyRequestId: "privacy-1", reason: "Customer access request" }),
    /Privacy request not found/,
  );
  });

  test("privacy export requires a specific reason", async () => {
  const repository: PrivacyExportRepository = {
    async findPrivacyRequest() {
      throw new Error("should not query request");
    },
    async findSubjectRecords() {
      throw new Error("should not query records");
    },
    async recordAuditEvent() {
      throw new Error("should not audit invalid reason");
    },
  };
  const service = await createService(repository);

  await assert.rejects(
    service.buildExport({ actor, privacyRequestId: "privacy-1", reason: " no " }),
    /Export reason is required/,
  );
  });

  test("privacy export records failed audit when record lookup throws", async () => {
  const auditEvents: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
  const repository: PrivacyExportRepository = {
    async findPrivacyRequest(id) {
      return { id, status: "open", subjectEmailNormalized: "client@example.com" };
    },
    async findSubjectRecords() {
      throw new Error("database unavailable");
    },
    async recordAuditEvent(input) {
      auditEvents.push(input);
    },
  };
  const service = await createService(repository);

  await assert.rejects(
    service.buildExport({ actor, privacyRequestId: "privacy-1", reason: "Customer access request" }),
    /database unavailable/,
  );
  assert.deepEqual(auditEvents.map((event) => event.action), ["privacy_export_attempt", "privacy_export_failed"]);
  assert.equal(auditEvents.some((event) => "reason" in event), false);
  assert.deepEqual(auditEvents[1].metadata, { error: "database unavailable" });
  });
}
