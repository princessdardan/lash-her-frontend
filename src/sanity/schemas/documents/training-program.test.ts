import assert from "node:assert";
import { describe, it } from "node:test";

import { trainingProgram } from "./training-program";

type ValidationResult = true | string;

type ValidationContextStub = {
  document?: { checkoutEnabled?: boolean };
};

type FieldValidator = (
  value: unknown,
  context: ValidationContextStub,
) => ValidationResult | Promise<ValidationResult>;

type RuleStub = {
  custom: (validator: FieldValidator) => RuleStub;
};

type SchemaField = {
  name?: string;
  group?: string;
  type?: string;
  of?: Array<{ type?: string; fields?: SchemaField[] }>;
  fields?: SchemaField[];
  validation?: (rule: RuleStub) => unknown;
  hidden?: unknown;
  readOnly?: unknown;
  deprecated?: { reason?: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSchemaField(value: unknown): value is SchemaField {
  return isRecord(value) && (value.name === undefined || typeof value.name === "string");
}

function getFieldValidator(name: string): FieldValidator {
  const field = getSchemaField(name);

  if (typeof field.validation !== "function") {
    assert.fail(`${name} validation should be configured`);
  }

  let capturedValidator: FieldValidator | undefined;
  const rule: RuleStub = {
    custom(validator) {
      capturedValidator = validator;
      return rule;
    },
  };

  field.validation(rule);
  assert.ok(capturedValidator, `${name} custom validator should be registered`);
  return capturedValidator;
}

function getSchemaField(name: string): SchemaField {
  const fields = trainingProgram.fields.map((field: unknown) => field);
  const schemaField = fields.find(
    (field) => isSchemaField(field) && field.name === name,
  );

  if (!isSchemaField(schemaField)) {
    assert.fail(`${name} field should be configured`);
  }

  return schemaField;
}

function buildContext(document: { checkoutEnabled?: boolean } = { checkoutEnabled: true }): ValidationContextStub {
  return { document };
}

describe("trainingProgram native commerce validation", () => {
  it("requires native price only when checkout is enabled", async () => {
    const validator = getFieldValidator("price");

    assert.strictEqual(await validator(undefined, buildContext()), "Training checkout requires a positive native price.");
    assert.strictEqual(await validator(0, buildContext()), "Training checkout requires a positive native price.");
    assert.strictEqual(await validator(1200, buildContext()), true);
    assert.strictEqual(await validator(undefined, buildContext({ checkoutEnabled: false })), true);
  });

  it("requires availability only when checkout is enabled", async () => {
    const validator = getFieldValidator("isAvailable");

    assert.strictEqual(await validator(undefined, buildContext()), "Set whether this training program is available for checkout.");
    assert.strictEqual(await validator(true, buildContext()), true);
    assert.strictEqual(await validator(false, buildContext()), true);
  });

  it("allows only Google Appointment Schedule URLs for paid training intro calls", async () => {
    const validator = getFieldValidator("introCallAppointmentScheduleUrl");

    assert.strictEqual(await validator(undefined, buildContext()), true);
    assert.strictEqual(
      await validator("https://calendar.google.com/calendar/appointments/schedules/AcZssZ_example", buildContext()),
      true,
    );
    assert.strictEqual(
      await validator("https://calendar.google.com/calendar/u/0/r/eventedit", buildContext()),
      "Use the public Google Appointment Schedule URL from calendar.google.com/calendar/appointments/schedules/.",
    );
    assert.strictEqual(
      await validator("https://example.com/calendar/appointments/schedules/AcZssZ_example", buildContext()),
      "Use the public Google Appointment Schedule URL from calendar.google.com/calendar/appointments/schedules/.",
    );
  });
});

describe("trainingProgram detail content schema", () => {
  it("configures native checkout commerce fields without exposing an editor currency field", () => {
    const schemaFieldNames = trainingProgram.fields
      .map((field: unknown) => isSchemaField(field) ? field.name : undefined)
      .filter((name): name is string => typeof name === "string");

    for (const fieldName of [
      "price",
      "isAvailable",
      "availabilityLabel",
      "fulfillmentNote",
      "introCallAppointmentScheduleUrl",
      "introCallAppointmentScheduleEmbedMode",
      "introCallSchedulingInstructions",
    ]) {
      assert.strictEqual(getSchemaField(fieldName).group, "checkout", `${fieldName} should be in the checkout group`);
    }

    assert.ok(!schemaFieldNames.includes("currency"));
    assert.ok(
      !trainingProgram.fields.some((field: unknown) => isSchemaField(field) && field.group === "checkout" && field.type === "reference"),
      "checkout fields should be native training fields, not catalog references",
    );
  });

  it("configures paid intro-call Appointment Schedule as editorial public fields", () => {
    const urlField = getSchemaField("introCallAppointmentScheduleUrl");
    const modeField = getSchemaField("introCallAppointmentScheduleEmbedMode") as SchemaField & {
      options?: { layout?: string; list?: Array<{ title?: string; value?: string }> };
    };
    const instructionsField = getSchemaField("introCallSchedulingInstructions");

    assert.strictEqual(urlField.type, "url");
    assert.strictEqual(modeField.type, "string");
    assert.strictEqual(modeField.options?.layout, "radio");
    assert.deepStrictEqual(modeField.options?.list?.map((item) => item.value), ["link", "embed"]);
    assert.strictEqual(instructionsField.type, "text");
  });

  it("does not include removed detail image or enrollment inclusion fields", () => {
    const schemaFieldNames = trainingProgram.fields
      .map((field: unknown) => isSchemaField(field) ? field.name : undefined)
      .filter((name): name is string => typeof name === "string");

    assert.ok(!schemaFieldNames.includes("detailHeroImage"), "detailHeroImage should be removed");
    assert.ok(!schemaFieldNames.includes("detailMainImage"), "detailMainImage should be removed");
    assert.ok(!schemaFieldNames.includes("enrollmentInclusions"), "enrollmentInclusions should be removed");
  });

  it("configures detail items with eyelash field and without image", () => {
    const detailItems = getSchemaField("detailItems");
    const memberFields = detailItems.of?.[0]?.fields;

    assert.ok(memberFields, "detailItems member should have fields");
    const fieldNames = memberFields?.map((f) => f.name);
    assert.ok(fieldNames?.includes("eyelash"), "detailItems should have eyelash field");
    assert.ok(fieldNames?.includes("title"), "detailItems should have title field");
    assert.ok(fieldNames?.includes("description"), "detailItems should have description field");
    assert.ok(!fieldNames?.includes("image"), "detailItems should not have image field");
  });

  it("groups fields into overview, curriculum, enrollment, checkout, legacy, and seo", () => {
    const groupNames = trainingProgram.groups?.map((g) => g.name) ?? [];
    assert.deepStrictEqual(groupNames, ["overview", "curriculum", "enrollment", "checkout", "legacy", "seo"]);

    assert.strictEqual(getSchemaField("title").group, "overview");
    assert.strictEqual(getSchemaField("heroImage").group, "overview");
    assert.strictEqual(getSchemaField("detailHeading").group, "curriculum");
    assert.strictEqual(getSchemaField("detailItems").group, "curriculum");
    assert.strictEqual(getSchemaField("factList").group, "curriculum");
    assert.strictEqual(getSchemaField("enrollmentTitle").group, "enrollment");
    assert.strictEqual(getSchemaField("primaryCta").group, "enrollment");
    assert.strictEqual(getSchemaField("blocks").group, "legacy");
    assert.strictEqual(getSchemaField("seo").group, "seo");
  });

  it("configures the structured training contact section and deprecates legacy contact blocks", () => {
    const trainingContact = getSchemaField("trainingContact");
    const blocks = getSchemaField("blocks");
    const allowedTypes = blocks.of?.map((member) => member.type) ?? [];

    assert.strictEqual(trainingContact.type, "trainingContactSection");
    assert.strictEqual(trainingContact.group, "enrollment");
    assert.deepStrictEqual(allowedTypes, ["contactFormLabels"]);
    assert.strictEqual(blocks.readOnly, true);
    assert.ok(blocks.deprecated?.reason?.includes("Training Contact Section"));
    assert.strictEqual(typeof blocks.hidden, "function");
  });
});
