import assert from "node:assert/strict";
import test from "node:test";
import { getAdminAuthorizationActor, runAdminAuthorizationOperation } from "./authorization-operation";
import { AdminAuthError } from "./types";
import { markWriterOperationUncertain, withWriterOperationContext } from "@/lib/writer-admission/context";
import { WriterAdmissionError } from "@/lib/writer-admission/config";
import { interactiveAdmissionFixture } from "@/lib/writer-admission/interactive-fixture";

test("closed admin authorization refuses before actor resolution, persistence and resource reads", async () => {
  const fixture = interactiveAdmissionFixture();
  fixture.state.open = false;
  let calls = 0;
  await assert.rejects(runAdminAuthorizationOperation(async () => { calls++; }, fixture.run), WriterAdmissionError);
  assert.equal(calls, 0);
});

test("admin authorization remains active through post-write resource lookup", async () => {
  const fixture = interactiveAdmissionFixture();
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const operation = runAdminAuthorizationOperation(async () => {
    fixture.events.push("identity-persisted");
    started();
    await held;
    fixture.events.push("resources-loaded");
    return "actor";
  }, fixture.run);
  await entered;
  assert.equal(fixture.state.finished, false);
  release();
  assert.equal(await operation, "actor");
  assert.deepEqual(fixture.events, ["admitted", "identity-persisted", "resources-loaded", "settled"]);
});

test("known auth refusal settles before page redirect, but an uncertain audit cannot complete", async () => {
  const known = interactiveAdmissionFixture();
  await assert.rejects(runAdminAuthorizationOperation(async () => { throw new AdminAuthError("forbidden"); }, known.run), AdminAuthError);
  assert.equal(known.state.finished, true);
  assert.equal(known.state.uncertain, false);
  const unknown = interactiveAdmissionFixture();
  await assert.rejects(runAdminAuthorizationOperation(async () => {
    markWriterOperationUncertain();
    throw new AdminAuthError("forbidden");
  }, unknown.run), WriterAdmissionError);
  assert.equal(unknown.state.uncertain, true);
});

test("only a matching authorization parent can reuse admission", async () => {
  const fixture = interactiveAdmissionFixture();
  await withWriterOperationContext(() => runAdminAuthorizationOperation(() =>
    runAdminAuthorizationOperation(async () => "actor", async () => { throw new Error("redundant admission"); }), fixture.run));
  assert.deepEqual(fixture.events, ["admitted", "settled"]);
});

test("actor resolution requires an admitted authorization operation", async () => {
  let calls = 0;
  const resolve = async () => { calls++; throw new Error("must not resolve outside admission"); };
  assert.throws(() => getAdminAuthorizationActor(resolve), /ADMIN_AUTHORIZATION_OPERATION_REQUIRED/u);
  const fixture = interactiveAdmissionFixture(); fixture.state.open = false;
  await assert.rejects(runAdminAuthorizationOperation(() => getAdminAuthorizationActor(resolve), fixture.run), WriterAdmissionError);
  assert.equal(calls, 0);
});

test("a shared rejected actor promise cannot hide unknown persistence or audit outcomes", async () => {
  const fixture = interactiveAdmissionFixture(); let calls = 0;
  await assert.rejects(runAdminAuthorizationOperation(async () => {
    const resolve = async () => { calls++; markWriterOperationUncertain(); throw new AdminAuthError("disabled"); };
    const results = await Promise.allSettled([getAdminAuthorizationActor(resolve), getAdminAuthorizationActor(resolve)]);
    assert.ok(results.every(result => result.status === "rejected"));
  }, fixture.run), WriterAdmissionError);
  assert.equal(calls, 1); assert.equal(fixture.state.uncertain, true);
  assert.deepEqual(fixture.events, ["admitted", "settled"]);
});
