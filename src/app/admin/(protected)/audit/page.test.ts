import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pageSource = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

test("Activity history does not create self-referential page-view events", () => {
  assert.doesNotMatch(pageSource, /recordAdminAudit/);
  assert.doesNotMatch(pageSource, /audit_log_view/);
});

test("Activity history exposes filters, totals, accessible tables, and system details", () => {
  assert.match(pageSource, /Activity history/);
  assert.match(pageSource, /not a complete security or accounting/);
  assert.match(pageSource, /name="actor"/);
  assert.match(pageSource, /name="from"/);
  assert.match(pageSource, /name="to"/);
  assert.match(pageSource, /name="area"/);
  assert.match(pageSource, /name="result"/);
  assert.match(pageSource, /Showing \$\{firstVisible\}–\$\{lastVisible\} of/);
  assert.match(pageSource, /scope="col"/);
  assert.match(pageSource, /System details/);
  assert.match(pageSource, /Requested permission/);
  assert.match(pageSource, /md:hidden/);
  assert.match(pageSource, /hidden overflow-hidden.*md:block/);
});
