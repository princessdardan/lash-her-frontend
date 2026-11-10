import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run DB-backed step-up proof tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { createHash, randomUUID } from "node:crypto";
  import { eq, sql } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import { adminStepUpProofs, adminUsers } from "./src/lib/private-db/schema.ts";
  import { consumeAdminStepUpProof, createAdminStepUpTarget, issueAdminStepUpProof } from "./src/lib/admin/step-up-proof.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const db = getPrivateDb();
  const providerUserId = "step-up-proof-db-test";
  const otherProviderUserId = "step-up-proof-db-test-other";

  try {
    await db.delete(adminUsers).where(eq(adminUsers.providerUserId, providerUserId));
    await db.delete(adminUsers).where(eq(adminUsers.providerUserId, otherProviderUserId));
    const [actor] = await db.insert(adminUsers).values({
      email: "step-up-proof@example.invalid",
      emailNormalized: "step-up-proof@example.invalid",
      providerUserId,
      role: "owner",
      status: "active",
    }).returning({ id: adminUsers.id });
    const [otherActor] = await db.insert(adminUsers).values({
      email: "step-up-proof-other@example.invalid",
      emailNormalized: "step-up-proof-other@example.invalid",
      providerUserId: otherProviderUserId,
      role: "owner",
      status: "active",
    }).returning({ id: adminUsers.id });
    const now = new Date("2026-08-15T12:00:00.000Z");

    const suppressedAction = "owned:step_up_receipt";
    const suppressedConsumeAction = "owned:step_up_consume_receipt";
    const alteredConsumeAction = "owned:step_up_altered_consume_receipt";
    const fixtureName = "owned_step_up_" + randomUUID().replaceAll("-", "");
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(
        "CREATE FUNCTION " + fixtureName + "() RETURNS trigger LANGUAGE plpgsql AS $$ " +
        "BEGIN " +
        "IF TG_OP = 'INSERT' AND NEW.action = 'owned:step_up_receipt' THEN RETURN NULL; END IF; " +
        "IF TG_OP = 'UPDATE' AND NEW.action = 'owned:step_up_consume_receipt' THEN RETURN NULL; END IF; " +
        "IF TG_OP = 'UPDATE' AND NEW.action = 'owned:step_up_altered_consume_receipt' " +
        "THEN NEW.consumed_at = NEW.consumed_at + INTERVAL '1 second'; END IF; " +
        "RETURN NEW; END; $$",
      ));
      await tx.execute(sql.raw(
        "CREATE TRIGGER " + fixtureName + " BEFORE INSERT OR UPDATE ON public.admin_step_up_proofs " +
        "FOR EACH ROW EXECUTE FUNCTION " + fixtureName + "()",
      ));
    });
    try {
      await assert.rejects(issueAdminStepUpProof({
        action: suppressedAction,
        actorAdminUserId: actor.id,
        authenticatedAt: now,
        now,
        target: "owned",
      }), /Step-up proof was not persisted/);

      for (const action of [suppressedConsumeAction, alteredConsumeAction]) {
        const input = { action, actorAdminUserId: actor.id, authenticatedAt: now, now, target: "owned" };
        const proof = await issueAdminStepUpProof(input);
        for (const attempt of [
          input,
          { ...input, target: "other" },
          { ...input, now: new Date(now.getTime() + 301_000) },
        ]) {
          await assert.rejects(
            consumeAdminStepUpProof({ ...attempt, token: proof.token }),
            /Step-up proof consumption was not persisted/,
          );
        }
        const [stored] = await db.select({ consumedAt: adminStepUpProofs.consumedAt })
          .from(adminStepUpProofs)
          .where(eq(adminStepUpProofs.nonceHash, createHash("sha256").update(proof.token).digest("hex")));
        assert.equal(stored.consumedAt, null);
      }
    } finally {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw("DROP TRIGGER " + fixtureName + " ON public.admin_step_up_proofs"));
        await tx.execute(sql.raw("DROP FUNCTION " + fixtureName + "()"));
      });
    }

    const mismatched = await issueAdminStepUpProof({
      action: "address:address_approval",
      actorAdminUserId: actor.id,
      authenticatedAt: now,
      now,
      target: "address-1",
    });
    await assert.rejects(
      consumeAdminStepUpProof({
        action: "address:fraud_clearance",
        actorAdminUserId: actor.id,
        authenticatedAt: now,
        now,
        target: "address-1",
        token: mismatched.token,
      }),
      /does not match/,
    );
    await assert.rejects(
      consumeAdminStepUpProof({
        action: "address:address_approval",
        actorAdminUserId: actor.id,
        authenticatedAt: now,
        now,
        target: "address-1",
        token: mismatched.token,
      }),
      /already used/,
    );

    const targetMismatched = await issueAdminStepUpProof({
      action: "address:address_approval",
      actorAdminUserId: actor.id,
      authenticatedAt: now,
      now,
      target: "address-2",
    });
    await assert.rejects(
      consumeAdminStepUpProof({
        action: "address:address_approval",
        actorAdminUserId: actor.id,
        authenticatedAt: now,
        now,
        target: "address-other",
        token: targetMismatched.token,
      }),
      /does not match/,
    );

    const actorMismatched = await issueAdminStepUpProof({
      action: "manual:approve_cancellation",
      actorAdminUserId: actor.id,
      authenticatedAt: now,
      now,
      target: "order-actor-bound",
    });
    await assert.rejects(
      consumeAdminStepUpProof({
        action: "manual:approve_cancellation",
        actorAdminUserId: otherActor.id,
        authenticatedAt: now,
        now,
        target: "order-actor-bound",
        token: actorMismatched.token,
      }),
      /does not match/,
    );

    const valid = await issueAdminStepUpProof({
      action: "risk:clear_false_positive",
      actorAdminUserId: actor.id,
      authenticatedAt: now,
      now,
      target: "incident-1",
    });
    assert.equal((await consumeAdminStepUpProof({
      action: "risk:clear_false_positive",
      actorAdminUserId: actor.id,
      authenticatedAt: now,
      now,
      target: "incident-1",
      token: valid.token,
    })).toISOString(), now.toISOString());
    await assert.rejects(
      consumeAdminStepUpProof({
        action: "risk:clear_false_positive",
        actorAdminUserId: actor.id,
        authenticatedAt: now,
        now,
        target: "incident-1",
        token: valid.token,
      }),
      /already used/,
    );

    const concurrent = await issueAdminStepUpProof({
      action: "manual:pickup_complete",
      actorAdminUserId: actor.id,
      authenticatedAt: now,
      now,
      target: "order-concurrent",
    });
    const concurrentResults = await Promise.allSettled([
      consumeAdminStepUpProof({
        action: "manual:pickup_complete",
        actorAdminUserId: actor.id,
        authenticatedAt: now,
        now,
        target: "order-concurrent",
        token: concurrent.token,
      }),
      consumeAdminStepUpProof({
        action: "manual:pickup_complete",
        actorAdminUserId: actor.id,
        authenticatedAt: now,
        now,
        target: "order-concurrent",
        token: concurrent.token,
      }),
    ]);
    assert.equal(
      concurrentResults.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      concurrentResults.filter((result) => result.status === "rejected").length,
      1,
    );

    const expiredToken = "expired-step-up-token";
    await db.insert(adminStepUpProofs).values({
      action: "manual:approve_cancellation",
      actorAdminUserId: actor.id,
      authenticatedAt: new Date("2026-08-15T11:50:00.000Z"),
      expiresAt: new Date("2026-08-15T11:55:00.000Z"),
      nonceHash: createHash("sha256").update(expiredToken).digest("hex"),
      target: createAdminStepUpTarget("order-1"),
    });
    await assert.rejects(
      consumeAdminStepUpProof({
        action: "manual:approve_cancellation",
        actorAdminUserId: actor.id,
        authenticatedAt: new Date("2026-08-15T11:50:00.000Z"),
        now,
        target: "order-1",
        token: expiredToken,
      }),
      /expired/,
    );
  } finally {
    await db.delete(adminUsers).where(eq(adminUsers.providerUserId, providerUserId));
    await db.delete(adminUsers).where(eq(adminUsers.providerUserId, otherProviderUserId));
    await closePrivateDbPool();
  }
`;

test(
  "step-up proof requires persisted issue and consume receipts and is action/target bound, single-use, and expiring",
  { skip: dbTestSkipReason },
  () => {
    execFileSync(
      process.execPath,
      [
        "--conditions=react-server",
        "--input-type=module",
        "--import",
        "tsx",
        "--eval",
        scenario,
      ],
      { cwd: process.cwd(), env: process.env, stdio: "pipe" },
    );
  },
);
