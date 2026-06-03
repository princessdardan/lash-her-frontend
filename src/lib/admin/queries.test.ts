import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function runScenario(source: string) {
  const directory = await mkdtemp(join(tmpdir(), "admin-queries-test-"));
  const scenarioPath = join(directory, "scenario.ts");

  try {
    await writeFile(scenarioPath, source);
    const { stderr } = await execFileAsync("./node_modules/.bin/tsx", ["--conditions=react-server", scenarioPath], {
      cwd: process.cwd(),
    });

    assert.equal(stderr, "");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function createScenario(body: string): string {
  const moduleUrl = pathToFileURL(join(process.cwd(), "src/lib/admin/queries.ts")).href;

  return String.raw`
    import assert from "node:assert/strict";

    const now = new Date("2026-06-02T12:00:00Z");

    const repository = {
      async listRecentOrders() {
        return [
          {
            amountCents: 4500,
            createdAt: now,
            currency: "CAD",
            customerEmail: "client@example.com",
            customerName: "Client Example",
            id: "order-db-1",
            orderId: "lh-product-1",
            purpose: "product",
            status: "paid",
          },
          {
            amountCents: 2500,
            bookingHoldId: "hold-paid-1",
            createdAt: now,
            currency: "CAD",
            customerEmail: "booking@example.com",
            customerName: "Booking Client",
            id: "order-db-2",
            orderId: "lh-service-1",
            purpose: "appointment_deposit",
            status: "paid",
          },
          {
            amountCents: 90000,
            createdAt: now,
            currency: "CAD",
            customerEmail: "student@example.com",
            customerName: "Student Example",
            id: "order-db-3",
            orderId: "lh-training-1",
            purpose: "training",
            status: "paid",
          },
          {
            amountCents: 1000,
            createdAt: now,
            currency: "CAD",
            customerEmail: "refund@example.com",
            customerName: "Refund Example",
            id: "order-db-4",
            orderId: "lh-refund-1",
            purpose: "product",
            status: "refunded",
          },
        ];
      },
      async listAttentionBookings() {
        return [
          {
            createdAt: now,
            customerSnapshot: { email: "booking@example.com", name: "Booking Client", phone: "555" },
            finalizationStatus: "failed",
            id: "hold-1",
            publicReference: "LH-HOLD-1",
            selectedStart: now,
            status: "booking_failed",
          },
        ];
      },
      async listMarketingSummaryRows() {
        return [{ contacts: 10, source: "contact_popup", submissions: 14, unsubscribes: 1 }];
      },
      async listPrivacyRequests() {
        return [
          {
            id: "privacy-1",
            requestType: "access_export",
            status: "open",
            subjectEmailNormalized: "client@example.com",
          },
        ];
      },
    };

    async function main() {
      const { createAdminQueryService } = await import(${JSON.stringify(moduleUrl)});
      ${body}
    }

    main().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;
}

test("admin query service builds command center inbox and summaries", async () => {
  await runScenario(createScenario(String.raw`
    const service = createAdminQueryService(repository);

    const data = await service.getCommandCenterData();

    assert.equal(data.inboxItems[0].domain, "booking");
    assert.equal(data.cards.openPrivacyRequests, 1);
    assert.equal(data.cards.recentRevenueCents, 97000);
  `));
});

test("admin query service maps revenue rows by purchase domain", async () => {
  await runScenario(createScenario(String.raw`
    const service = createAdminQueryService(repository);

    const rows = await service.listRevenueRows();

    assert.deepEqual(rows, [
      {
        amount: "$45.00 CAD",
        amountCents: 4500,
        createdAt: now,
        customerName: "Client Example",
        domain: "product",
        href: "/admin/orders/order-db-1",
        orderId: "lh-product-1",
        status: "Paid",
      },
      {
        amount: "$25.00 CAD",
        amountCents: 2500,
        createdAt: now,
        customerName: "Booking Client",
        domain: "service",
        href: "/admin/bookings/hold-paid-1",
        orderId: "lh-service-1",
        status: "Paid",
      },
      {
        amount: "$900.00 CAD",
        amountCents: 90000,
        createdAt: now,
        customerName: "Student Example",
        domain: "training",
        href: "/admin/training/order-db-3",
        orderId: "lh-training-1",
        status: "Paid",
      },
      {
        amount: "$10.00 CAD",
        amountCents: 1000,
        createdAt: now,
        customerName: "Refund Example",
        domain: "product",
        href: "/admin/orders/order-db-4",
        orderId: "lh-refund-1",
        status: "Refunded",
      },
    ]);
  `));
});
