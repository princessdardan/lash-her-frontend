import assert from "node:assert/strict";
import test from "node:test";

import { submitContactPopup } from "./form";

test("contact popup rejects overlong offer-recipient fields before persistence", async () => {
  const overlongEmail = await submitContactPopup({
    email: `${"x".repeat(310)}@example.com`,
    variant: "emailOnly",
  });
  assert.equal(overlongEmail.success, false);
  assert.ok(overlongEmail.fieldErrors?.email);

  const overlongName = await submitContactPopup({
    email: "bounded-name@example.com",
    name: "x".repeat(201),
    variant: "fullContact",
  });
  assert.equal(overlongName.success, false);
  assert.equal(overlongName.fieldErrors?.name, "Name is too long");
});

test("contact popup rejects an invalid runtime variant", async () => {
  const result = await submitContactPopup({
    email: "invalid-variant@example.com",
    variant: "unexpected" as "emailOnly",
  });

  assert.deepEqual(result, {
    success: false,
    error: "Something went wrong, please try again.",
  });
});
