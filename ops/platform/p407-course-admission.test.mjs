import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Client } from "pg";
import { runFrontendWriterOperation } from "./frontend-admission.mjs";
import {
  bootstrapP407CourseAdmission, changeP407CourseAdmission, observeP407CourseAdmission,
  P407_ADMISSION_OWNER, P407_ADMISSION_RUNTIME, P407_ADMISSION_TARGET, planP407CourseAdmission,
} from "./p407-course-admission.mjs";

const review = {
  sourceCommit: "a".repeat(40),
  orderId: randomUUID(),
  customerId: randomUUID(),
  courseId: randomUUID(),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

test("candidate producer binds the exact scope and isolated runtime target", () => {
  const plan = planP407CourseAdmission(review);
  assert.equal(plan.target.user, P407_ADMISSION_TARGET.user);
  assert.equal(plan.writerAdmissionTarget.user, P407_ADMISSION_RUNTIME);
  assert.equal(plan.writerAdmissionTarget.targetSha256, plan.target.targetSha256);
  for (const change of [{ orderId: randomUUID() }, { courseId: randomUUID() }, { customerId: randomUUID() },
    { sourceCommit: "b".repeat(40) }, { expiresAt: "2026-11-29T00:00:00.000Z" }])
    assert.notEqual(planP407CourseAdmission({ ...review, ...change }).producer, plan.producer);
  assert.throws(() => planP407CourseAdmission({ ...review, orderId: "00000000-0000-0000-0000-000000000000" }));
  assert.throws(() => planP407CourseAdmission({ ...review, expiresAt: "2026-11-29" }));
});

test("PostgreSQL rejects cross-order admission and retires the one-order producer",
  { skip: process.env.OWNED_P407_ADMISSION_TEST !== "true" }, async () => {
    const port = Number(process.env.OWNED_P407_ADMISSION_PORT);
    const password = process.env.OWNED_P407_ADMISSION_PASSWORD;
    assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
    assert.match(password, /^owned-[a-f0-9-]{36}$/u);
    const ca = readFileSync(process.env.OWNED_P407_ADMISSION_CA);
    const all = [];
    const connect = async (user, database = P407_ADMISSION_TARGET.database) => {
      const client = new Client({ host: "127.0.0.1", port, user, password, database,
        ssl: { ca, servername: P407_ADMISSION_TARGET.host, rejectUnauthorized: true }, enableChannelBinding: true });
      await client.connect();
      all.push(client);
      return client;
    };
    try {
      const admin = await connect("postgres", "postgres");
      assert.equal((await admin.query("SHOW server_version_num")).rows[0].server_version_num.slice(0, 2), "18");
      await admin.query(`CREATE ROLE ${P407_ADMISSION_TARGET.user} LOGIN NOINHERIT PASSWORD '${password}';
        CREATE ROLE ${P407_ADMISSION_RUNTIME} LOGIN NOINHERIT PASSWORD '${password}'`);
      await admin.query(`CREATE DATABASE ${P407_ADMISSION_TARGET.database} OWNER ${P407_ADMISSION_TARGET.user}`);
      const migration = await connect(P407_ADMISSION_TARGET.user);
      await migration.query(`CREATE TABLE public.course_purchase_orders (
        id uuid PRIMARY KEY, customer_id uuid NOT NULL, course_id uuid NOT NULL, status text NOT NULL,
        square_payment_id text, source_fingerprint text, charged_at timestamptz)`);
      const runtime = await connect(P407_ADMISSION_RUNTIME);
      const observer = await connect("postgres");
      const provision = readFileSync(new URL("./p407-course-admission-roles.sql", import.meta.url), "utf8")
        .split("\n").slice(1).join("\n");
      await assert.rejects(admin.query(provision));
      await admin.query("ROLLBACK");
      await observer.query(provision);
      const direct = { connection: migration.connection, connectionParameters: { host: P407_ADMISSION_TARGET.host, port: 5432 },
        query: migration.query.bind(migration) };
      const plan = planP407CourseAdmission(review);
      const change = (epoch, phase, selection = review) => changeP407CourseAdmission(direct, selection, epoch, phase);
      const bootstrap = await bootstrapP407CourseAdmission(direct, review);
      assert.deepEqual(bootstrap, { epoch: "1", phase: "held", expiresAt: null, newWork: false, recovery: false, active: 0, uncertain: 0 });
      await assert.rejects(bootstrapP407CourseAdmission(direct, review));
      await assert.rejects(observeP407CourseAdmission({ ...direct, connectionParameters: { host: "shared.invalid", port: 5432 } }, review));
      let effects = 0;
      const operation = (epoch, kind, p407CourseOrderId) => ({
        id: randomUUID(), epoch, kind, p407CourseOrderId, producerSha256: plan.producer, sourceSha: plan.sourceCommit,
      });
      const run = (op, task = () => { effects++; }) => runFrontendWriterOperation(runtime, plan.target, op, task);
      await assert.rejects(run(operation("1", "new-work", review.orderId)));
      await assert.rejects(change("1", "recovery"));
      await assert.rejects(change("1", "checkout", { ...review, orderId: randomUUID() }));
      await assert.rejects(runtime.query("SELECT * FROM frontend_admission.p407_window"));
      await assert.rejects(runtime.query(`SET ROLE ${P407_ADMISSION_OWNER}`));
      const checkout = await change("1", "checkout");
      await assert.rejects(run(operation(checkout.epoch, "new-work")));
      await assert.rejects(run(operation(checkout.epoch, "new-work", randomUUID())));
      await assert.rejects(run(operation(checkout.epoch, "recovery", review.orderId)));
      await assert.rejects(run({ ...operation(checkout.epoch, "new-work", review.orderId), sourceSha: "b".repeat(40) }));
      await assert.rejects(change(checkout.epoch, "recovery"));
      assert.equal(effects, 0);
      await run(operation(checkout.epoch, "new-work", review.orderId), async () => {
        effects++;
        await migration.query(`INSERT INTO public.course_purchase_orders(id,customer_id,course_id,status)
          VALUES($1,$2,$3,'quoted')`, [review.orderId, review.customerId, review.courseId]);
      });
      const uncertainCheckout = operation(checkout.epoch, "new-work", review.orderId);
      await assert.rejects(run(uncertainCheckout, () => { throw new Error("simulated uncertain checkout result"); }),
        /FRONTEND_OPERATION_OUTCOME_REQUIRES_REVIEW/u);
      const uncertain = await observeP407CourseAdmission(direct, review);
      assert.equal(uncertain.active, 0);
      assert.equal(uncertain.uncertain, 1);
      await assert.rejects(change(checkout.epoch, "recovery"), /P407_ADMISSION_OPERATION_REQUIRES_REVIEW/u);
      assert.deepEqual(await observeP407CourseAdmission(direct, review), uncertain);
      await assert.rejects(run(operation(checkout.epoch, "new-work", review.orderId)));
      const settlement = { operationId: uncertainCheckout.id, evidenceSha256: "8".repeat(64) };
      const resume = (evidence, epoch = checkout.epoch) =>
        changeP407CourseAdmission(direct, review, epoch, "recovery", evidence);
      await assert.rejects(resume({ ...settlement, operationId: randomUUID() }));
      await assert.rejects(resume({ ...settlement, evidenceSha256: "0".repeat(64) }));
      await assert.rejects(resume(settlement, "1"));
      await assert.rejects(resume(settlement));
      assert.deepEqual(await observeP407CourseAdmission(direct, review), uncertain);
      await migration.query(`UPDATE public.course_purchase_orders
        SET status='charging',square_payment_id='owned-payment' WHERE id=$1`, [review.orderId]);
      const recovery = await resume(settlement);
      assert.equal(recovery.uncertain, 0);
      assert.equal(recovery.newWork, false);
      assert.equal(recovery.recovery, true);
      assert.deepEqual((await observer.query(`SELECT state,reconciliation_sha256
        FROM frontend_admission.operations WHERE id=$1`, [uncertainCheckout.id])).rows,
      [{ state: "completed", reconciliation_sha256: settlement.evidenceSha256 }]);
      await assert.rejects(resume(settlement));
      await assert.rejects(run(operation(recovery.epoch, "new-work", review.orderId)));
      await assert.rejects(run(operation(recovery.epoch, "recovery", randomUUID())));
      await observer.query("UPDATE frontend_admission.p407_window SET expires_at=clock_timestamp()-interval '1 second'");
      await assert.rejects(run(operation(recovery.epoch, "recovery", review.orderId)));
      await observer.query("UPDATE frontend_admission.p407_window SET expires_at=clock_timestamp()+interval '1 minute'");
      let entered;
      let release;
      const active = new Promise((resolve) => { entered = resolve; });
      const finish = new Promise((resolve) => { release = resolve; });
      const recoveryOp = operation(recovery.epoch, "recovery", review.orderId);
      const pending = run(recoveryOp, async () => {
        effects++;
        entered();
        await finish;
      });
      try {
        await Promise.race([active, pending]);
        const closed = await change(recovery.epoch, "closed");
        assert.equal(closed.active, 1);
        assert.equal(closed.uncertain, 0);
        assert.equal(closed.recovery, false);
      } finally {
        release();
        await pending;
      }
      const closed = await observeP407CourseAdmission(direct, review);
      assert.equal(closed.active, 0);
      assert.equal(closed.uncertain, 0);
      assert.equal(closed.recovery, false);
      await assert.rejects(run({ ...recoveryOp, epoch: closed.epoch }));
      await assert.rejects(run(operation(closed.epoch, "recovery", review.orderId)));
      await assert.rejects(change(closed.epoch, "checkout"));
      assert.deepEqual(await observeP407CourseAdmission(direct, review), closed);
      assert.equal(effects, 2);
    } finally {
      await Promise.allSettled(all.map((client) => client.end()));
    }
  });
