import assert from "node:assert/strict";
import test from "node:test";

import { adminTabLinkClassName } from "./admin-tab-link";

test("selected admin tabs keep readable text and use multiple active indicators", () => {
  const className = adminTabLinkClassName(true);

  assert.match(className, /\btext-lh-primary\b/);
  assert.match(className, /\bborder-lh-primary\b/);
  assert.match(className, /\bbg-lh-primary-soft\b/);
  assert.doesNotMatch(className, /\btext-white\b/);
  assert.doesNotMatch(className, /\bbg-white\b/);
});

test("unselected admin tabs retain the neutral treatment", () => {
  const className = adminTabLinkClassName(false);

  assert.match(className, /\btext-lh-shadow\b/);
  assert.match(className, /\bborder-lh-line\b/);
  assert.match(className, /\bbg-white\b/);
});
