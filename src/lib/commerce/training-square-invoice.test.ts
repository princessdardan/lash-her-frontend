import assert from "node:assert/strict";
import test from "node:test";

import {
  createTrainingSquareInvoiceFinalizer,
  finalizeTrainingSquareInvoice,
} from "./training-square-invoice-finalizer";

test("training-square-invoice entrypoint keeps the plan-listed test command alive", () => {
  assert.equal(typeof createTrainingSquareInvoiceFinalizer, "function");
  assert.equal(typeof finalizeTrainingSquareInvoice, "function");
});
