import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { AdminActionFeedback } from "./admin-action-feedback";

test("admin feedback never renders legacy employee terminology", () => {
  const html = renderToStaticMarkup(
    createElement(AdminActionFeedback, {
      error: "Employee assignments are outside these employees' resources.",
    }),
  );

  assert.match(
    html,
    /Contractor assignments are outside these contractors&#x27; resources\./,
  );
  assert.doesNotMatch(html, /\bemployees?\b/i);
});
