import assert from "node:assert/strict";
import test from "node:test";
import { runAdminReadOperation } from "./read-operation";
import { loadAdmittedCalendarPage } from "./calendar-discovery-page";
import { loadCalendarDiscoveryResult } from "./calendar-discovery-result";
import { AdminAuthError } from "./types";
import { markWriterOperationUncertain, withWriterOperationContext } from "@/lib/writer-admission/context";
import { WriterAdmissionError } from "@/lib/writer-admission/config";
import { interactiveAdmissionFixture } from "@/lib/writer-admission/interactive-fixture";
import { settleWriterEffects } from "@/lib/writer-admission/settle";

for (const domain of ["appointment-detail", "marketing-contacts", "calendar-discovery"] as const) {
  test(`${domain} refuses before authorization or business effects when recovery is closed`, async () => {
    const fixture = interactiveAdmissionFixture();
    fixture.state.open = false;
    let effects = 0;
    await assert.rejects(runAdminReadOperation(domain, async () => { effects++; }, fixture.run), WriterAdmissionError);
    assert.equal(effects, 0);
  });
}

test("read operations use eligible recovery and only matching semantic parents reuse it", async () => {
  const fixture = interactiveAdmissionFixture();
  const kinds: string[] = [];
  const run: typeof fixture.run = (kind, work) => { kinds.push(kind); return fixture.run(kind, work); };
  await withWriterOperationContext(() => runAdminReadOperation("appointment-detail", async () => {
    await runAdminReadOperation("appointment-detail", async () => "same", async () => { throw new Error("unexpected nested admission"); });
    await runAdminReadOperation("marketing-contacts", async () => "different", run);
  }, run));
  assert.deepEqual(kinds, ["recovery", "recovery"]);
  assert.deepEqual(fixture.events, ["admitted", "admitted", "settled", "settled"]);
});

test("known denials settle before Calendar redirects; uncertain denial audits stay unresolved", async () => {
  for (const code of ["unauthenticated", "forbidden"] as const) {
    const fixture = interactiveAdmissionFixture();
    const redirect = (path: string): never => {
      assert.equal(fixture.state.finished, true);
      assert.equal(fixture.state.uncertain, false);
      throw new Error(`redirect:${path}`);
    };
    await assert.rejects(loadAdmittedCalendarPage(async () => { throw new AdminAuthError(code); }, { run: fixture.run, redirect }), new RegExp(code === "unauthenticated" ? "/admin/sign-in" : "/admin/not-authorized"));
  }
  const fixture = interactiveAdmissionFixture();
  let redirected = false;
  await assert.rejects(loadAdmittedCalendarPage(async () => {
    markWriterOperationUncertain();
    throw new AdminAuthError("forbidden");
  }, { run: fixture.run, redirect: () => { redirected = true; throw new Error("redirect"); } }), WriterAdmissionError);
  assert.equal(redirected, false);
  assert.equal(fixture.state.uncertain, true);
});

test("Calendar page awaits every discovery before settling a rejected sibling", async () => {
  const fixture = interactiveAdmissionFixture();
  let release!: () => void;
  let entered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = loadAdmittedCalendarPage(() => settleWriterEffects([
    Promise.reject(new WriterAdmissionError("unavailable")),
    (async () => { entered(); await hold; fixture.events.push("last-page-read"); })(),
  ]), { run: fixture.run });
  const assertion = assert.rejects(pending, WriterAdmissionError);
  await started;
  assert.equal(fixture.state.finished, false);
  release();
  await assertion;
  assert.deepEqual(fixture.events, ["admitted", "last-page-read", "settled"]);
  assert.equal(fixture.state.uncertain, true);
});

test("caught Calendar errors retain unknown outcomes while known denials propagate", async () => {
  const fixture = interactiveAdmissionFixture();
  await assert.rejects(runAdminReadOperation("calendar-discovery", () =>
    loadCalendarDiscoveryResult(async () => { throw new Error("unknown refresh outcome"); }), fixture.run), WriterAdmissionError);
  assert.equal(fixture.state.uncertain, true);
  for (const error of [new AdminAuthError("forbidden"), new WriterAdmissionError("unavailable")]) {
    await assert.rejects(loadCalendarDiscoveryResult(async () => { throw error; }), error);
  }
  assert.deepEqual(await loadCalendarDiscoveryResult(async () => []), { kind: "ready", calendars: [] });
});

test("an unrelated writer cannot bypass admission and swallowed nested failure marks its parent", async () => {
  const inner = interactiveAdmissionFixture();
  inner.state.open = false;
  const outer = interactiveAdmissionFixture();
  await assert.rejects(outer.run("new-work", async () => {
    try { await runAdminReadOperation("calendar-discovery", async () => "must not run", inner.run); } catch { /* UI fallback */ }
  }), WriterAdmissionError);
  assert.equal(outer.state.uncertain, true);
});
