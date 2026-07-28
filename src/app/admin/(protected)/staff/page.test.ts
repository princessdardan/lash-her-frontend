import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pageSource = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const actionsSource = readFileSync(
  new URL("../actions.ts", import.meta.url),
  "utf8",
);

test("staff Square mapping controls submit opaque selection handles", () => {
  assert.match(pageSource, /name="squareTeamMemberSelectionHandle"/);
  assert.match(pageSource, /value=\{member\.selectionHandle\}/);
  assert.doesNotMatch(pageSource, /value=\{member\.id\}/);
  assert.doesNotMatch(
    pageSource,
    /defaultValue=\{provider\.squareTeamMemberId/,
  );
  assert.doesNotMatch(pageSource, /name="squareTeamMemberId"/);

  assert.match(
    actionsSource,
    /getOptionalString\(formData,\s*"squareTeamMemberSelectionHandle"\)/,
  );
  assert.doesNotMatch(
    actionsSource,
    /getOptionalString\(formData,\s*"squareTeamMemberId"\)/,
  );
});
