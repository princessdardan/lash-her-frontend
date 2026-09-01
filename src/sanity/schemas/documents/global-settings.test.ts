import assert from "node:assert/strict";
import test from "node:test";

import { globalSettings } from "./global-settings";

type ValidationResult = true | string;
type Validator = (
  value: unknown,
  context: { parent?: unknown },
) => ValidationResult | Promise<ValidationResult>;
type RuleStub = { custom: (validator: Validator) => RuleStub };
type SchemaField = {
  name?: string;
  type?: string;
  weak?: boolean;
  to?: Array<{ type?: string }>;
  fields?: SchemaField[];
  options?: { filter?: string };
  validation?: (rule: RuleStub) => unknown;
};

test("contact popup signup promotion is a filtered strong reference", () => {
  const promotion = getContactPopupField("signupPromotion");

  assert.equal(promotion.type, "reference");
  assert.equal(promotion.weak, false);
  assert.deepEqual(promotion.to, [{ type: "promotionCode" }]);
  assert.equal(
    promotion.options?.filter,
    'isEnabled == true && appliesTo == "all"',
  );
});

test("signup offer fields are conditionally required", async () => {
  for (const fieldName of [
    "signupPromotion",
    "signupOfferLabel",
    "signupOfferTerms",
    "signupOfferCtaLabel",
  ]) {
    const validator = getValidator(fieldName);
    assert.equal(
      await validator(undefined, { parent: { signupOfferEnabled: false } }),
      true,
      fieldName,
    );
    assert.equal(
      typeof (await validator(undefined, {
        parent: { signupOfferEnabled: true },
      })),
      "string",
      fieldName,
    );
  }

  assert.equal(
    await getValidator("signupPromotion")(
      { _type: "reference", _ref: "promotion-1" },
      { parent: { signupOfferEnabled: true } },
    ),
    true,
  );
  assert.equal(
    await getValidator("signupOfferLabel")("Welcome offer", {
      parent: { signupOfferEnabled: true },
    }),
    true,
  );
  assert.equal(
    await getValidator("signupOfferLabel")("x".repeat(501), {
      parent: { signupOfferEnabled: true },
    }),
    "Must be 500 characters or fewer.",
  );
});

test("enabled signup offers require an absolute HTTPS CTA URL", async () => {
  const validator = getValidator("signupOfferCtaUrl");

  assert.equal(
    await validator(undefined, { parent: { signupOfferEnabled: false } }),
    true,
  );
  assert.equal(
    await validator("http://example.com/products", {
      parent: { signupOfferEnabled: true },
    }),
    "Signup offer CTA URL must be an absolute HTTPS URL.",
  );
  assert.equal(
    await validator("https://example.com/products", {
      parent: { signupOfferEnabled: true },
    }),
    true,
  );
  assert.equal(
    await validator(`https://example.com/${"x".repeat(2_000)}`, {
      parent: { signupOfferEnabled: true },
    }),
    "Signup offer CTA URL must be 2000 characters or fewer.",
  );
});

function getContactPopupField(name: string): SchemaField {
  const fields = globalSettings.fields as SchemaField[];
  const contactPopup = fields.find((field) => field.name === "contactPopup");
  const field = contactPopup?.fields?.find((entry) => entry.name === name);
  assert.ok(field, `${name} should exist in contactPopup`);
  return field;
}

function getValidator(name: string): Validator {
  const field = getContactPopupField(name);
  assert.ok(field.validation, `${name} should have validation`);

  let validator: Validator | undefined;
  const rule: RuleStub = {
    custom(candidate) {
      validator = candidate;
      return rule;
    },
  };
  field.validation(rule);
  assert.ok(validator, `${name} should register a custom validator`);
  return validator;
}
