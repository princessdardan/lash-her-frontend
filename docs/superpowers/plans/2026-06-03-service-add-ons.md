# Service Add-ons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one optional Sanity-managed service add-on to booking flows, with full payment including the add-on and deposit/custom partial payments remaining service-only.

**Architecture:** Add-ons are embedded objects on each Sanity `service` document and projected through the existing service loader. The booking client sends only `selectedAddOnKey`; `/api/booking/holds` reloads the published service, validates the key, snapshots selected add-on/payment data into the private hold, and Square checkout continues to use one line item from the private payment snapshot.

**Tech Stack:** Next.js 16 App Router, React, Sanity Studio schemas/GROQ, TypeScript, Node test runner via `tsx`, private PostgreSQL/Drizzle hold snapshots, Square hosted checkout.

---

## File Structure

- Modify `src/sanity/schemas/documents/service.ts`: add embedded `addOns` field and add-on price validation.
- Modify `src/sanity/schemas/documents/service.test.ts`: schema contract tests for embedded add-ons and validation.
- Modify `src/types/index.ts`: add `TServiceAddOn` and extend `TService`.
- Modify `src/data/loaders.ts`: include `addOns` in `SERVICE_PROJECTION`.
- Modify `src/components/booking/booking-flow.tsx`: track selected add-on, render single-select UI, update summary/payment labels, and send `selectedAddOnKey`.
- Modify `src/components/booking/booking-flow.test.ts`: source-contract and fetch-contract tests for add-on UI/payment behavior.
- Modify `src/app/api/booking/holds/route.ts`: parse/validate `selectedAddOnKey`, compute add-on-aware full payment, snapshot selected add-on.
- Modify `src/app/api/booking/holds/route.test.ts`: route tests for no add-on, valid add-on, stale add-on, and payment matrix.
- Modify `src/lib/booking/payment-policy.ts`: expose tolerant selected add-on snapshot parsing for downstream confirmation/staff surfaces.
- Create `src/lib/booking/payment-policy.test.ts`: unit tests for selected add-on snapshot parsing without changing existing payment parsing.
- Modify `src/lib/booking/square-service-checkout.test.ts`: assert Square uses snapshotted combined amount for full + add-on and service-only amounts for deposit/custom partial.
- Modify confirmation/email/finalizer files after locating the current staff/customer copy paths: include selected add-on details and paid/due-later wording.

---

### Task 1: Add Sanity service add-on schema

**Files:**
- Modify: `src/sanity/schemas/documents/service.test.ts`
- Modify: `src/sanity/schemas/documents/service.ts`

- [ ] **Step 1: Write failing schema contract tests**

Append these tests inside the existing `describe("service schema payment contract", () => { ... })` block in `src/sanity/schemas/documents/service.test.ts`:

```ts
  it("defines embedded service add-ons with required public fields", () => {
    const addOnsField = getField("addOns") as SchemaField & {
      type?: string;
      of?: Array<{ type?: string; fields?: SchemaField[] }>;
    };

    assert.equal(addOnsField.type, "array");
    assert.ok(Array.isArray(addOnsField.of));
    assert.equal(addOnsField.of?.[0]?.type, "object");

    const addOnFields = addOnsField.of?.[0]?.fields ?? [];
    const addOnFieldNames = addOnFields.map((field) => field.name);

    assert.ok(addOnFieldNames.includes("name"));
    assert.ok(addOnFieldNames.includes("description"));
    assert.ok(addOnFieldNames.includes("image"));
    assert.ok(addOnFieldNames.includes("price"));
    assert.ok(!addOnFieldNames.includes("isAvailable"));
  });

  it("requires positive add-on prices", async () => {
    const addOnsField = getField("addOns") as SchemaField & {
      of?: Array<{ fields?: SchemaField[] }>;
    };
    const priceField = addOnsField.of?.[0]?.fields?.find((field) => field.name === "price");

    assert.ok(priceField, "add-on price field should be configured");
    assert.equal(typeof priceField.validation, "function");

    let capturedValidator: FieldValidator | undefined;
    const rule: RuleStub = {
      custom(validator) {
        capturedValidator = validator;
        return rule;
      },
    };

    priceField.validation(rule);
    assert.ok(capturedValidator, "add-on price custom validator should be registered");
    assert.strictEqual(await capturedValidator(undefined, buildContext()), "Add-on price is required.");
    assert.strictEqual(await capturedValidator(0, buildContext()), "Add-on price must be greater than zero.");
    assert.strictEqual(await capturedValidator(25, buildContext()), true);
  });
```

- [ ] **Step 2: Run the schema test and verify it fails**

Run:

```bash
npx tsx --test src/sanity/schemas/documents/service.test.ts
```

Expected: FAIL because `addOns` does not exist.

- [ ] **Step 3: Add the Sanity schema field and validator**

In `src/sanity/schemas/documents/service.ts`, add this validator after `validateFullPrice`:

```ts
function validateAddOnPrice(value: unknown) {
  if (typeof value !== "number") return "Add-on price is required.";

  if (!Number.isFinite(value) || value <= 0) {
    return "Add-on price must be greater than zero.";
  }

  return true;
}
```

Then add this field after `depositAmount` and before `currency`:

```ts
    defineField({
      name: "addOns",
      title: "Add-ons",
      type: "array",
      group: "pricing",
      of: [
        defineArrayMember({
          type: "object",
          title: "Add-on",
          fields: [
            defineField({ name: "name", title: "Name", type: "string", validation: (Rule) => Rule.required() }),
            defineField({ name: "description", title: "Description", type: "text", rows: 2, validation: (Rule) => Rule.required() }),
            defineField({
              name: "image",
              title: "Image",
              type: "image",
              options: { hotspot: true },
              fields: [defineField({ name: "alt", title: "Alt text", type: "string" })],
            }),
            defineField({ name: "price", title: "Price", type: "number", validation: (Rule) => Rule.custom(validateAddOnPrice) }),
          ],
          preview: {
            select: { title: "name", subtitle: "price", media: "image" },
            prepare({ title, subtitle, media }) {
              return { title, subtitle: typeof subtitle === "number" ? `$${subtitle.toFixed(2)} CAD` : undefined, media };
            },
          },
        }),
      ],
    }),
```

- [ ] **Step 4: Run the schema test and verify it passes**

Run:

```bash
npx tsx --test src/sanity/schemas/documents/service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit schema changes**

Run:

```bash
git add src/sanity/schemas/documents/service.ts src/sanity/schemas/documents/service.test.ts
git commit -m "feat: add service add-on schema"
```

---

### Task 2: Project add-ons through service data contracts

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/data/loaders.ts`
- Modify: `src/components/booking/booking-flow.test.ts`

- [ ] **Step 1: Write failing projection/type contract tests**

In `src/components/booking/booking-flow.test.ts`, add this import near the existing `readFileSync` constants:

```ts
const loadersSource = readFileSync(new URL("../../data/loaders.ts", import.meta.url), "utf8");
const typesSource = readFileSync(new URL("../../types/index.ts", import.meta.url), "utf8");
```

Add this test inside `describe("booking service flow contract", () => { ... })`:

```ts
  it("projects service add-ons with stable keys and image metadata", () => {
    assert.match(typesSource, /export interface TServiceAddOn/);
    assert.match(typesSource, /addOns\?: TServiceAddOn\[\]/);
    assert.match(loadersSource, /addOns\[\]\{ _key, name, description, price, image\{ asset, hotspot, crop, alt \} \}/);
  });
```

- [ ] **Step 2: Run the booking flow contract test and verify it fails**

Run:

```bash
npx tsx --test src/components/booking/booking-flow.test.ts
```

Expected: FAIL because `TServiceAddOn` and `addOns` projection do not exist.

- [ ] **Step 3: Extend TypeScript service types**

In `src/types/index.ts`, add this interface immediately before `export interface TService`:

```ts
export interface TServiceAddOn {
  _key: string;
  name: string;
  description: string;
  price: number;
  image?: TSanityImage;
}
```

Inside `TService`, add this property after `depositAmount: number;`:

```ts
  addOns?: TServiceAddOn[];
```

- [ ] **Step 4: Extend the GROQ service projection**

In `src/data/loaders.ts`, update `SERVICE_PROJECTION` so the pricing fields read:

```ts
  fullPrice,
  depositAmount,
  addOns[]{ _key, name, description, price, image{ asset, hotspot, crop, alt } },
  currency,
```

- [ ] **Step 5: Run the contract test and verify it passes**

Run:

```bash
npx tsx --test src/components/booking/booking-flow.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit data contract changes**

Run:

```bash
git add src/types/index.ts src/data/loaders.ts src/components/booking/booking-flow.test.ts
git commit -m "feat: project service add-ons"
```

---

### Task 3: Add client-side add-on selection and request contract

**Files:**
- Modify: `src/components/booking/booking-flow.test.ts`
- Modify: `src/components/booking/booking-flow.tsx`

- [ ] **Step 1: Write failing client contract tests**

Append these assertions to `src/components/booking/booking-flow.test.ts` inside the existing `describe` block:

```ts
  it("renders a single optional add-on picker and explains due-later balances", () => {
    assert.match(bookingFlowSource, /selectedAddOnKey/);
    assert.match(bookingFlowSource, /Optional add-on/);
    assert.match(bookingFlowSource, /No add-on/);
    assert.match(bookingFlowSource, /Only one add-on can be selected/);
    assert.match(bookingFlowSource, /add-on balance is due later/i);
  });

  it("clears selected add-ons when the selected service changes", () => {
    assert.match(bookingFlowSource, /setSelectedAddOnKey\(null\)/);
  });

  it("posts only the selected add-on key to private hold creation", () => {
    assert.match(bookingFlowSource, /selectedAddOnKey: input\.selectedAddOnKey/);
    assert.doesNotMatch(bookingFlowSource, /selectedAddOnName|selectedAddOnPrice|computedTotal/);
  });
```

Extend the `starts paid offering checkout with hold and checkout requests` test call to include `selectedAddOnKey: "addon-lash-bath"` and extend the expected hold body with `selectedAddOnKey: "addon-lash-bath"`.

- [ ] **Step 2: Run the client contract test and verify it fails**

Run:

```bash
npx tsx --test src/components/booking/booking-flow.test.ts
```

Expected: FAIL because the add-on UI state and request field do not exist.

- [ ] **Step 3: Extend client input types and state**

In `src/components/booking/booking-flow.tsx`, change the type import to include `TServiceAddOn`:

```ts
import type { TService, TServiceAddOn } from "@/types";
```

Then extend `PaidServiceCheckoutInput` after `serviceSlug: string;`:

```ts
  selectedAddOnKey?: string;
```

Inside `BookingFlow`, add state after `customAmount`:

```ts
  const [selectedAddOnKey, setSelectedAddOnKey] = useState<string | null>(null);
```

Add these derived values after `currentServicePayment`:

```ts
  const currentServiceAddOns = currentService?.addOns ?? [];
  const selectedAddOn = currentServiceAddOns.find((addOn) => addOn._key === selectedAddOnKey);
  const displayTotal = currentService
    ? currentService.fullPrice + (selectedAddOn?.price ?? 0)
    : currentServicePayment?.fullPrice;
```

In `handleServiceSelect`, add this line after `setSlots([]);`:

```ts
    setSelectedAddOnKey(null);
```

- [ ] **Step 4: Render the add-on picker before payment options**

In `src/components/booking/booking-flow.tsx`, insert this block immediately before `{currentServicePayment && (` in the details form:

```tsx
          {currentServiceAddOns.length > 0 && (
            <div className="border-t border-border/50 pt-4">
              <h3 className="section-subheading mb-4 text-lg text-primary md:text-lg lg:text-lg">Optional add-on</h3>
              <p className="mb-4 text-sm text-muted-foreground">Only one add-on can be selected for this booking. Add-ons do not change your appointment duration.</p>
              <div className="space-y-3" role="radiogroup" aria-label="Optional add-on">
                <button
                  type="button"
                  role="radio"
                  aria-checked={selectedAddOnKey === null}
                  onClick={() => setSelectedAddOnKey(null)}
                  className={`w-full rounded-xl border p-4 text-left transition-colors ${selectedAddOnKey === null ? "border-lh-primary ring-1 ring-lh-primary" : "border-lh-line hover:border-lh-primary"}`}
                >
                  <div className="flex items-center justify-between gap-4">
                    <span className="font-medium text-black">No add-on</span>
                    <span className="text-sm text-lh-muted">Included</span>
                  </div>
                </button>
                {currentServiceAddOns.map((addOn) => {
                  const isSelected = selectedAddOnKey === addOn._key;
                  return (
                    <button
                      key={addOn._key}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      onClick={() => setSelectedAddOnKey(addOn._key)}
                      className={`w-full rounded-xl border p-4 text-left transition-colors ${isSelected ? "border-lh-primary ring-1 ring-lh-primary" : "border-lh-line hover:border-lh-primary"}`}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="font-medium text-black">{addOn.name}</p>
                          <p className="mt-1 text-sm text-lh-muted">{addOn.description}</p>
                        </div>
                        <span className="shrink-0 font-medium text-black">+{formatCad(addOn.price)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
```

- [ ] **Step 5: Update payment labels and checkout request**

Change the submit call object in `handleSubmit` to include the selected key:

```ts
        ...(selectedAddOnKey ? { selectedAddOnKey } : {}),
```

Change the full payment option label to:

```tsx
                      <SelectItem value="full">Pay in Full ({formatCad(displayTotal ?? currentServicePayment.fullPrice)})</SelectItem>
```

After the custom amount field block and before `</div>` for payment options, add:

```tsx
                {selectedAddOn && paymentOption !== "full" && (
                  <p className="text-sm text-lh-muted">
                    Your selected add-on balance is due later unless you choose Pay in Full.
                  </p>
                )}
```

In `startPaidServiceCheckout`, add this property to the `/api/booking/holds` body after `serviceSlug`:

```ts
      ...(input.selectedAddOnKey ? { selectedAddOnKey: input.selectedAddOnKey } : {}),
```

- [ ] **Step 6: Update booking summary signature and display**

Change every `BookingSummary` call to pass `selectedAddOn={selectedAddOn}`.

Replace the summary function signature with:

```tsx
function BookingSummary({ service, selectedAddOn, selectedSlot, timezone }: { service?: TService; selectedAddOn?: TServiceAddOn; selectedSlot: string; timezone: string }) {
```

Inside the summary, after the duration line, add:

```tsx
      {selectedAddOn && (
        <div className="flex justify-between text-sm">
          <span className="text-lh-muted">{selectedAddOn.name}</span>
          <span className="text-black">+{formatCad(selectedAddOn.price)}</span>
        </div>
      )}
```

Change the total amount line to:

```tsx
          <span>{formatCad(service.fullPrice + (selectedAddOn?.price ?? 0))}</span>
```

- [ ] **Step 7: Run the client contract test and verify it passes**

Run:

```bash
npx tsx --test src/components/booking/booking-flow.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit client booking changes**

Run:

```bash
git add src/components/booking/booking-flow.tsx src/components/booking/booking-flow.test.ts
git commit -m "feat: add booking add-on selection"
```

---

### Task 4: Validate and snapshot selected add-ons in hold creation

**Files:**
- Modify: `src/app/api/booking/holds/route.test.ts`
- Modify: `src/app/api/booking/holds/route.ts`

- [ ] **Step 1: Write failing hold route tests**

In the helper `createService` object in `src/app/api/booking/holds/route.test.ts`, add:

```js
      addOns: [
        { _key: "addon-lash-bath", name: "Lash Bath", description: "A gentle cleansing add-on", price: 25 },
      ],
```

Add these tests before `booking hold route rejects slots blocked by active private holds`:

```ts
test("booking hold route snapshots full payments with selected add-ons", () => {
  runRouteScenario(`
    const selectedStart = createFutureDate(2, 0);
    const createInputs = [];
    const handler = createHoldHandler({
      listCalendarEvents: async () => [],
      createAppointmentHold: async (input) => {
        createInputs.push(input);
        return {
          ok: true,
          hold: {
            publicReference: "hold_public_1",
            expiresAt: new Date("2026-06-01T12:10:00.000Z"),
            selectedStart: input.selectedStart,
            selectedEnd: input.selectedEnd,
          },
        };
      },
    });

    const response = await handler(createRequest({
      serviceSlug: "classic-fill",
      start: selectedStart.toISOString(),
      name: "Client Name",
      email: "client@example.com",
      phone: "555-0100",
      paymentOption: "full",
      selectedAddOnKey: "addon-lash-bath",
    }));

    assert.equal(response.status, 201);
    assert.deepEqual(createInputs[0].offeringSnapshot.selectedAddOn, {
      key: "addon-lash-bath",
      name: "Lash Bath",
      description: "A gentle cleansing add-on",
      price: 25,
      currency: "CAD",
    });
    assert.deepEqual(createInputs[0].offeringSnapshot.selectedPayment, {
      amount: 175,
      description: "Classic Fill full payment with Lash Bath",
      option: "full",
      purpose: "appointment_full",
      sku: "BOOKING-FULL",
    });
  `);
});

test("booking hold route keeps deposit and custom partial amounts service-only with selected add-ons", () => {
  runRouteScenario(`
    const selectedStart = createFutureDate(2, 0);
    const createInputs = [];
    const handler = createHoldHandler({
      listCalendarEvents: async () => [],
      createAppointmentHold: async (input) => {
        createInputs.push(input);
        return {
          ok: true,
          hold: {
            publicReference: "hold_public_1",
            expiresAt: new Date("2026-06-01T12:10:00.000Z"),
            selectedStart: input.selectedStart,
            selectedEnd: input.selectedEnd,
          },
        };
      },
    });

    const depositResponse = await handler(createRequest({
      serviceSlug: "classic-fill",
      start: selectedStart.toISOString(),
      name: "Client Name",
      email: "client@example.com",
      phone: "555-0100",
      paymentOption: "deposit",
      selectedAddOnKey: "addon-lash-bath",
    }));
    const customResponse = await handler(createRequest({
      serviceSlug: "classic-fill",
      start: selectedStart.toISOString(),
      name: "Client Name",
      email: "client@example.com",
      phone: "555-0100",
      paymentOption: "customPartial",
      customAmount: 100,
      selectedAddOnKey: "addon-lash-bath",
    }));

    assert.equal(depositResponse.status, 201);
    assert.equal(customResponse.status, 201);
    assert.equal(createInputs[0].offeringSnapshot.selectedPayment.amount, 50);
    assert.equal(createInputs[1].offeringSnapshot.selectedPayment.amount, 100);
    assert.match(createInputs[0].offeringSnapshot.selectedPayment.description, /add-on balance due later/);
    assert.match(createInputs[1].offeringSnapshot.selectedPayment.description, /add-on balance due later/);
  `);
});

test("booking hold route rejects stale selected add-on keys", () => {
  runRouteScenario(`
    const selectedStart = createFutureDate(2, 0);
    let createCalled = false;
    const handler = createHoldHandler({
      listCalendarEvents: async () => [],
      createAppointmentHold: async () => {
        createCalled = true;
        return { ok: false, reason: "slot_conflict", conflictingHoldId: "hold-1" };
      },
    });

    const response = await handler(createRequest({
      serviceSlug: "classic-fill",
      start: selectedStart.toISOString(),
      name: "Client Name",
      email: "client@example.com",
      phone: "555-0100",
      paymentOption: "full",
      selectedAddOnKey: "stale-add-on",
    }));
    const body = await parseJson(response);

    assert.equal(response.status, 400);
    assert.equal(createCalled, false);
    assert.deepEqual(body, {
      error: "Please fix the hold details and try again.",
      fieldErrors: { selectedAddOnKey: "That add-on is no longer available. Please review your selection." },
    });
  `);
});
```

- [ ] **Step 2: Run the hold route test and verify it fails**

Run:

```bash
npx tsx --test src/app/api/booking/holds/route.test.ts
```

Expected: FAIL because `selectedAddOnKey` is ignored.

- [ ] **Step 3: Add request and snapshot types**

In `src/app/api/booking/holds/route.ts`, add to `BookingHoldRequestInput` after `serviceSlug: string;`:

```ts
  selectedAddOnKey?: string;
```

Add this interface after `BookingPaymentSelectionSnapshot`:

```ts
interface BookingAddOnSelectionSnapshot {
  key: string;
  name: string;
  description: string;
  price: number;
  currency: "CAD";
}
```

- [ ] **Step 4: Parse selected add-on key**

In `toBookingHoldRequestInput`, add:

```ts
  const selectedAddOnKey = toOptionalStringValue(record.selectedAddOnKey);
```

Then include in the returned object after `serviceSlug`:

```ts
    ...(selectedAddOnKey ? { selectedAddOnKey } : {}),
```

- [ ] **Step 5: Resolve selected add-on server-side**

Add these helpers near `getPaymentSelection`:

```ts
function getSelectedAddOn(
  service: TService,
  selectedAddOnKey?: string,
): BookingAddOnSelectionSnapshot | null | "invalid" {
  if (!selectedAddOnKey) return null;

  const addOn = service.addOns?.find((candidate) => candidate._key === selectedAddOnKey);
  if (!addOn) return "invalid";

  const price = toPositiveAmount(addOn.price);
  if (price === null) return "invalid";

  return {
    key: addOn._key,
    name: addOn.name.trim(),
    description: addOn.description.trim(),
    price,
    currency: "CAD",
  };
}
```

After `const paymentSelection = getPaymentSelection(service, input);`, replace that line with:

```ts
      const selectedAddOn = getSelectedAddOn(service, input.selectedAddOnKey);

      if (selectedAddOn === "invalid") {
        return Response.json(
          {
            error: "Please fix the hold details and try again.",
            fieldErrors: { selectedAddOnKey: "That add-on is no longer available. Please review your selection." },
          },
          { status: 400 },
        );
      }

      const paymentSelection = getPaymentSelection(service, input, selectedAddOn);
```

- [ ] **Step 6: Update payment selection calculations**

Change the signature of `getPaymentSelection` to:

```ts
function getPaymentSelection(
  service: TService,
  input: BookingHoldRequestInput,
  selectedAddOn: BookingAddOnSelectionSnapshot | null,
): BookingPaymentSelectionSnapshot | null {
```

Change calls to `resolveFixedPaymentSelection` so they pass `selectedAddOn`:

```ts
    return resolveFixedPaymentSelection(service, "deposit", selectedAddOn);
```

```ts
    return resolveFixedPaymentSelection(service, "full", selectedAddOn);
```

Change the custom partial return description to:

```ts
      description: selectedAddOn
        ? `${service.title} custom partial payment; ${selectedAddOn.name} add-on balance due later`
        : `${service.title} custom partial payment`,
```

Change `resolveFixedPaymentSelection` signature to:

```ts
function resolveFixedPaymentSelection(
  service: TService,
  option: "deposit" | "full",
  selectedAddOn: BookingAddOnSelectionSnapshot | null,
): BookingPaymentSelectionSnapshot | null {
```

In the deposit branch, change description to:

```ts
          description: selectedAddOn
            ? `${service.title} deposit; ${selectedAddOn.name} add-on balance due later`
            : `${service.title} deposit`,
```

In the full branch, compute amount as:

```ts
  const serviceAmount = toPositiveAmount(service.fullPrice);
  const amount = serviceAmount === null ? null : serviceAmount + (selectedAddOn?.price ?? 0);
```

and change description to:

```ts
        description: selectedAddOn
          ? `${service.title} full payment with ${selectedAddOn.name}`
          : `${service.title} full payment`,
```

- [ ] **Step 7: Snapshot selected add-on**

Change `toServiceSnapshot` signature to:

```ts
function toServiceSnapshot(
  service: TService,
  input: BookingHoldRequestInput,
  paymentSelection: BookingPaymentSelectionSnapshot,
  selectedAddOn: BookingAddOnSelectionSnapshot | null,
): Record<string, unknown> {
```

Update the `offeringSnapshot` call to pass `selectedAddOn`:

```ts
        offeringSnapshot: toServiceSnapshot(service, input, paymentSelection, selectedAddOn),
```

Inside the snapshot object, add after `currency: service.currency,`:

```ts
    ...(selectedAddOn ? { selectedAddOn } : {}),
```

- [ ] **Step 8: Run the hold route test and verify it passes**

Run:

```bash
npx tsx --test src/app/api/booking/holds/route.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit hold validation changes**

Run:

```bash
git add src/app/api/booking/holds/route.ts src/app/api/booking/holds/route.test.ts
git commit -m "feat: snapshot booking add-ons"
```

---

### Task 5: Centralize selected add-on snapshot parsing

**Files:**
- Create: `src/lib/booking/payment-policy.test.ts`
- Modify: `src/lib/booking/payment-policy.ts`

- [ ] **Step 1: Write failing payment policy tests**

Create `src/lib/booking/payment-policy.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { getBookingPaymentSelection, getBookingSelectedAddOn } from "./payment-policy";
import type { BookingHoldRecord } from "./holds";

function createHold(offeringSnapshot: Record<string, unknown>): BookingHoldRecord {
  return {
    id: "hold-1",
    publicReference: "hold_public_1",
    bookingType: "in-person-appointment",
    customer: { name: "Client", email: "client@example.com", phone: "555-0100" },
    offeringId: "service-classic-fill",
    offeringSnapshot,
    selectedStart: new Date("2030-06-15T16:00:00.000Z"),
    selectedEnd: new Date("2030-06-15T17:00:00.000Z"),
    timezone: "UTC",
    state: "held",
    expiresAt: new Date("2030-06-15T15:45:00.000Z"),
    createdAt: new Date("2030-06-15T15:30:00.000Z"),
    updatedAt: new Date("2030-06-15T15:30:00.000Z"),
  } satisfies BookingHoldRecord;
}

test("payment policy parses selected add-on snapshots without affecting selected payment", () => {
  const hold = createHold({
    title: "Classic Fill",
    currency: "CAD",
    selectedAddOn: {
      key: "addon-lash-bath",
      name: "Lash Bath",
      description: "A gentle cleansing add-on",
      price: 25,
      currency: "CAD",
    },
    selectedPayment: {
      amount: 175,
      description: "Classic Fill full payment with Lash Bath",
      purpose: "appointment_full",
      sku: "BOOKING-FULL",
    },
  });

  assert.deepEqual(getBookingPaymentSelection(hold), {
    amount: 175,
    description: "Classic Fill full payment with Lash Bath",
    purpose: "appointment_full",
    sku: "BOOKING-FULL",
  });
  assert.deepEqual(getBookingSelectedAddOn(hold), {
    key: "addon-lash-bath",
    name: "Lash Bath",
    description: "A gentle cleansing add-on",
    price: 25,
    currency: "CAD",
  });
});

test("payment policy tolerates missing or malformed selected add-on snapshots", () => {
  const hold = createHold({
    title: "Classic Fill",
    currency: "CAD",
    selectedAddOn: { key: "addon-lash-bath", name: "", description: "", price: -1, currency: "CAD" },
    selectedPayment: {
      amount: 50,
      description: "Classic Fill deposit",
      purpose: "appointment_deposit",
      sku: "BOOKING-DEPOSIT",
    },
  });

  assert.equal(getBookingSelectedAddOn(hold), null);
  assert.equal(getBookingPaymentSelection(hold)?.amount, 50);
});
```

- [ ] **Step 2: Run the payment policy test and verify it fails**

Run:

```bash
npx tsx --test src/lib/booking/payment-policy.test.ts
```

Expected: FAIL because `getBookingSelectedAddOn` is not exported.

- [ ] **Step 3: Implement selected add-on parsing**

In `src/lib/booking/payment-policy.ts`, add this interface after `BookingPaymentSelection`:

```ts
export interface BookingSelectedAddOnSnapshot {
  key: string;
  name: string;
  description: string;
  price: number;
  currency: "CAD";
}
```

Add to `BookingOfferingPaymentSnapshot`:

```ts
  selectedAddOn: BookingSelectedAddOnSnapshot | null;
```

Add this export after `getBookingPaymentOfferingTitle`:

```ts
export function getBookingSelectedAddOn(hold: BookingHoldRecord): BookingSelectedAddOnSnapshot | null {
  return toBookingOfferingPaymentSnapshot(hold.offeringSnapshot)?.selectedAddOn ?? null;
}
```

In `toBookingOfferingPaymentSnapshot`, add:

```ts
  const selectedAddOn = toBookingSelectedAddOn(value.selectedAddOn);
```

and include `selectedAddOn` in the returned object.

Add this helper before `toPositiveAmount`:

```ts
function toBookingSelectedAddOn(value: unknown): BookingSelectedAddOnSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const key = typeof value.key === "string" && value.key.trim().length > 0 ? value.key.trim() : null;
  const name = typeof value.name === "string" && value.name.trim().length > 0 ? value.name.trim() : null;
  const description = typeof value.description === "string" && value.description.trim().length > 0 ? value.description.trim() : null;
  const price = toPositiveAmount(value.price);

  if (key === null || name === null || description === null || price === null || value.currency !== "CAD") {
    return null;
  }

  return { key, name, description, price, currency: "CAD" };
}
```

- [ ] **Step 4: Run the payment policy test and verify it passes**

Run:

```bash
npx tsx --test src/lib/booking/payment-policy.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit payment policy parsing**

Run:

```bash
git add src/lib/booking/payment-policy.ts src/lib/booking/payment-policy.test.ts
git commit -m "feat: parse booking add-on snapshots"
```

---

### Task 6: Verify Square checkout uses snapshotted payment amounts

**Files:**
- Modify: `src/lib/booking/square-service-checkout.test.ts`

- [ ] **Step 1: Add Square checkout regression tests**

In `src/lib/booking/square-service-checkout.test.ts`, add a test that creates a hold with:

```ts
offeringSnapshot: {
  title: "Classic Fill",
  currency: "CAD",
  selectedAddOn: {
    key: "addon-lash-bath",
    name: "Lash Bath",
    description: "A gentle cleansing add-on",
    price: 25,
    currency: "CAD",
  },
  selectedPayment: {
    amount: 175,
    description: "Classic Fill full payment with Lash Bath",
    purpose: "appointment_full",
    sku: "BOOKING-FULL",
  },
}
```

Assert the fake Square client receives:

```ts
assert.equal(request.order.line_items[0].base_price_money.amount, 17500);
assert.equal(request.order.line_items[0].name, "Classic Fill full payment with Lash Bath");
```

Add a second scenario with deposit + add-on due later and assert `5000` cents, not `7500`.

- [ ] **Step 2: Run Square checkout tests**

Run:

```bash
npx tsx --test src/lib/booking/square-service-checkout.test.ts
```

Expected: PASS because Square already uses `selectedPayment.amount`; if it fails, update only the test fixture shape to match the current `BookingHoldRecord` builder used in the file.

- [ ] **Step 3: Commit Square regression tests**

Run:

```bash
git add src/lib/booking/square-service-checkout.test.ts
git commit -m "test: cover add-on Square checkout amounts"
```

---

### Task 7: Add confirmation/staff add-on copy

**Files:**
- Inspect and modify one or more of:
  - `src/lib/booking/email.ts`
  - `src/lib/booking/finalizer.ts`
  - `src/lib/booking/square-payment-finalizer.test.ts`
  - `src/lib/resend-template-seeding.test.ts`

- [ ] **Step 1: Locate current booking confirmation copy builders**

Run:

```bash
rg "bookingTypeLabel|formattedStart|appointment" src/lib/booking src/lib/resend-template-seeding.ts src/lib/resend-template-seeding.test.ts
```

Expected: identify the function that turns a finalized service booking/hold into customer and staff-visible copy.

- [ ] **Step 2: Write failing copy tests**

Add assertions to the existing email/finalizer test closest to the located copy builder. The test input must include `offeringSnapshot.selectedAddOn` and a `selectedPayment` for deposit or custom partial. Assert the generated copy includes:

```ts
assert.match(renderedTextOrHtml, /Lash Bath/);
assert.match(renderedTextOrHtml, /\$25\.00|25 CAD|CAD 25/);
assert.match(renderedTextOrHtml, /add-on balance is due later/i);
```

Add a full-payment scenario and assert:

```ts
assert.match(renderedTextOrHtml, /Lash Bath/);
assert.match(renderedTextOrHtml, /add-on included in payment/i);
```

- [ ] **Step 3: Run the focused copy test and verify it fails**

Run the focused test file found in Step 1, for example:

```bash
npx tsx --test src/lib/booking/square-payment-finalizer.test.ts
```

Expected: FAIL because selected add-on details are not rendered yet.

- [ ] **Step 4: Implement copy using the centralized parser**

In the located booking copy builder, import:

```ts
import { getBookingSelectedAddOn, getBookingPaymentSelection } from "@/lib/booking/payment-policy";
```

Build copy like this from the hold:

```ts
const selectedAddOn = getBookingSelectedAddOn(hold);
const paymentSelection = getBookingPaymentSelection(hold);
const addOnPaymentCopy = selectedAddOn
  ? paymentSelection?.purpose === "appointment_full"
    ? `${selectedAddOn.name} add-on included in payment.`
    : `${selectedAddOn.name} add-on (${formatCad(selectedAddOn.price)}) balance is due later.`
  : null;
```

Append `addOnPaymentCopy` to customer confirmation and staff/internal notes only when it is non-null.

- [ ] **Step 5: Run the focused copy test and verify it passes**

Run the same focused test command from Step 3.

Expected: PASS.

- [ ] **Step 6: Commit confirmation/staff copy changes**

Run:

```bash
git add src/lib/booking src/lib/resend-template-seeding.ts src/lib/resend-template-seeding.test.ts
git commit -m "feat: include booking add-ons in confirmations"
```

If `git add` reports a pathspec that did not change, remove that unchanged path from the command and commit only changed files.

---

### Task 8: Run focused and full verification

**Files:**
- No source files expected unless verification exposes failures.

- [ ] **Step 1: Run focused unit tests**

Run:

```bash
npx tsx --test src/sanity/schemas/documents/service.test.ts
npx tsx --test src/components/booking/booking-flow.test.ts
npx tsx --test src/app/api/booking/holds/route.test.ts
npx tsx --test src/lib/booking/payment-policy.test.ts
npx tsx --test src/lib/booking/square-service-checkout.test.ts
```

Expected: all PASS.

- [ ] **Step 2: Run all unit tests**

Run:

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 3: Run lint**

Run:

```bash
npm run lint
```

Expected: PASS.

- [ ] **Step 4: Run focused Playwright booking coverage if booking spec exists**

Run:

```bash
npx playwright test tests/booking.spec.ts --project=chromium
```

Expected: PASS. If `tests/booking.spec.ts` does not exist, run `npm test` and record that no focused booking spec exists.

- [ ] **Step 5: Run build**

Run:

```bash
npm run build
```

Expected: PASS. If `scripts/validate-sanity-env.mjs` blocks the build because local Sanity env vars are missing, record the exact message and run the repository-documented environment setup before re-running.

- [ ] **Step 6: Commit verification-only fixes if needed**

If verification required fixes, commit them:

```bash
git add <changed-files>
git commit -m "fix: stabilize service add-ons"
```

If no fixes were needed, do not create an empty commit.

---

## Self-Review Notes

- Spec coverage: schema, projection/types, UI, hold validation/snapshot, Square snapshot amount, confirmation/staff visibility, and tests are all covered by tasks above.
- No placeholders: each task includes exact paths, commands, expected results, and code snippets for the required changes.
- Type consistency: the selected add-on key is consistently named `selectedAddOnKey`; the private snapshot is consistently named `selectedAddOn`; the public type is `TServiceAddOn`.
