import { execFileSync } from "node:child_process";
import test from "node:test";

test("outbox claim sweeps an exhausted expired lease before claiming due work", () => {
  const scenario = String.raw`
    import assert from "node:assert/strict";
    import { PgDialect } from "drizzle-orm/pg-core";
    import { createDrizzleEntitlementOutboxRepository } from "./src/lib/course-commerce/drizzle-outbox-repository.ts";

    void (async () => {
    const updates = [];
    const predicates = [];
    const transaction = {
      update() {
        return {
          set(values) {
            updates.push(values);
            return {
              async where(predicate) {
                predicates.push(predicate);
                return [];
              },
            };
          },
        };
      },
      async execute() {
        assert.equal(updates.length, 1, "exhausted leases must be swept first");
        return { rows: [] };
      },
    };
    const database = {
      async transaction(operation) {
        return operation(transaction);
      },
    };

    const repository = createDrizzleEntitlementOutboxRepository(database);
    const jobs = await repository.claimDue({
      batchSize: 5,
      leaseDurationMs: 60_000,
      now: new Date("2026-08-07T12:00:00.000Z"),
      workerId: "worker-1",
    });

    assert.deepEqual(jobs, []);
    assert.equal(updates[0].status, "failed");
    assert.equal(updates[0].leaseOwner, null);
    assert.equal(updates[0].leaseExpiresAt, null);
    assert.match(updates[0].lastError, /LEASE_EXPIRED/);

    const query = new PgDialect().sqlToQuery(predicates[0]);
    assert.match(query.sql, /"entitlement_outbox"\."status" = \$1/);
    assert.match(query.sql, /"entitlement_outbox"\."lease_expires_at" <= \$2/);
    assert.match(
      query.sql,
      /"entitlement_outbox"\."attempts" >= "entitlement_outbox"\."max_attempts"/,
    );
    assert.deepEqual(query.params, [
      "processing",
      "2026-08-07T12:00:00.000Z",
    ]);
    })();
  `;

  execFileSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", scenario],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NEXT_PUBLIC_SANITY_DATASET: "test",
        NEXT_PUBLIC_SANITY_PROJECT_ID: "test-project",
      },
      stdio: "pipe",
    },
  );
});
