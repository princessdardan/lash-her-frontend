import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run shipping-policy job concurrency tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { and, eq, inArray } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import { shippingPolicyJobs } from "./src/lib/private-db/schema.ts";
  import { claimShippingPolicyJobs, enqueueDueShippingPolicyJobs, failShippingPolicyJob, renewShippingPolicyJobLease } from "./src/lib/shipping/policy-jobs.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const db = getPrivateDb();
  const first = new Date("2031-01-10T10:00:00.000Z");
  const laterBucket = new Date("2031-01-10T10:10:00.000Z");
  let ids = [];
  try {
    await Promise.all([
      enqueueDueShippingPolicyJobs(first),
      enqueueDueShippingPolicyJobs(laterBucket),
    ]);
    let active = await db.select().from(shippingPolicyJobs).where(and(
      eq(shippingPolicyJobs.type, "deadlines"),
      inArray(shippingPolicyJobs.status, ["queued", "processing", "retryable_failure"]),
    ));
    assert.equal(active.length, 1);
    ids = (await db.select({ id: shippingPolicyJobs.id }).from(shippingPolicyJobs).where(
      inArray(shippingPolicyJobs.status, ["queued", "processing", "retryable_failure"]),
    )).map((row) => row.id);

    const claimed = await claimShippingPolicyJobs({ now: laterBucket, limit: 50 });
    const deadline = claimed.find((job) => job.type === "deadlines");
    assert.ok(deadline);
    assert.equal(
      await renewShippingPolicyJobLease(deadline, new Date("2031-01-10T10:14:00.000Z")),
      true,
    );
    const overlap = await claimShippingPolicyJobs({
      now: new Date("2031-01-10T10:16:00.000Z"),
      limit: 50,
    });
    assert.equal(overlap.some((job) => job.id === deadline.id), false);
    const reclaimed = await claimShippingPolicyJobs({
      now: new Date("2031-01-10T10:20:00.000Z"),
      limit: 50,
    });
    const replacement = reclaimed.find((job) => job.id === deadline.id);
    assert.ok(replacement);
    assert.notEqual(replacement.leaseOwner, deadline.leaseOwner);
    assert.equal(
      await renewShippingPolicyJobLease(deadline, new Date("2031-01-10T10:20:01.000Z")),
      false,
    );
    assert.equal(
      await failShippingPolicyJob({ job: replacement, error: new Error("retry"), now: new Date("2031-01-10T10:20:01.000Z") }),
      "retryable_failure",
    );
    await enqueueDueShippingPolicyJobs(new Date("2031-01-10T10:30:00.000Z"));
    active = await db.select().from(shippingPolicyJobs).where(and(
      eq(shippingPolicyJobs.type, "deadlines"),
      inArray(shippingPolicyJobs.status, ["queued", "processing", "retryable_failure"]),
    ));
    assert.equal(active.length, 1);
    assert.equal(active[0].id, replacement.id);
  } finally {
    if (ids.length) await db.delete(shippingPolicyJobs).where(inArray(shippingPolicyJobs.id, ids));
    await closePrivateDbPool();
  }
`;

test(
  "policy jobs renew and fence one active task per type across overlaps and retries",
  { skip: dbTestSkipReason },
  () => {
    execFileSync(
      process.execPath,
      [
        "--conditions=react-server",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        scenario,
      ],
      { cwd: process.cwd(), env: process.env, stdio: "inherit" },
    );
  },
);
