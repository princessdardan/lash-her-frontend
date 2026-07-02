# Card-on-File Intake Contract Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the customer-facing card-on-file setup path safe, canonical, and recoverable before any no-show charge execution is enabled.

**Architecture:** Harden the browser/server contract at the Square tokenization boundary, make server-side policy evidence authoritative, align public config with server runtime requirements, and close booking saga recovery gaps around Square card persistence and Calendar duplication. This plan depends on the DB integrity foundation plan.

**Tech Stack:** React client components, Next.js App Router route handlers, Square Web Payments SDK, TypeScript, Drizzle/PostgreSQL, Node `tsx --test`, Playwright source-contract tests.

---

## Plan Set Position

This is **Plan 2 of 5** and depends on `2026-06-20-card-on-file-persistence-test-foundation.md`.

Production gate after this plan: card-on-file setup can be tested safely in staging, but no-show charge capture remains disabled until Plans 3–5 complete.

---

## Files

- Modify: `src/components/booking/square-card-on-file-form.tsx`
- Modify: `src/components/booking/booking-flow.test.ts`
- Modify: `src/lib/booking/payments/service-no-show-policy.ts`
- Modify: `src/lib/booking/payments/service-no-show-policy.test.ts`
- Modify: `src/lib/booking/payments/service-card-on-file.ts`
- Modify: `src/lib/booking/payments/service-card-on-file.test.ts`
- Modify: `src/lib/private-db/card-on-file-repository.ts`
- Modify: `src/app/api/booking/card-on-file/route.ts`
- Modify: `src/app/api/booking/card-on-file/route.test.ts`
- Modify: `src/app/api/booking/square/config/route.ts`
- Modify: `src/app/api/booking/square/config/route.test.ts`
- Modify: `src/lib/env/private-checkout.ts`
- Modify: `src/lib/env/private-checkout.test.ts`
- Modify: `src/lib/booking/payments/service-card-on-file-calendar-finalizer.ts`
- Modify: `src/lib/booking/payments/service-card-on-file.test.ts`

---

## Task 1: Fix Square Web Payments SDK STORE tokenization shape

**Files:**

- Modify: `src/components/booking/square-card-on-file-form.tsx:37-41, 219-228`
- Modify: `src/components/booking/booking-flow.test.ts`

- [ ] **Step 1: Write the source-contract test**

Add this assertion to the booking-flow card-on-file UI test group:

```ts
test("card-on-file form passes verificationDetails directly to Square tokenize", async () => {
  const source = await readFile(
    new URL("./square-card-on-file-form.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /cardRef\.current\.tokenize\(verificationDetails\)/);
  assert.doesNotMatch(source, /tokenize\(\{\s*verificationDetails\s*\}\)/);
});
```

- [ ] **Step 2: Run the focused test and see it fail**

Run:

```bash
npx tsx --test src/components/booking/booking-flow.test.ts
```

Expected before implementation: FAIL on the new direct-tokenize assertion.

- [ ] **Step 3: Update the Square card type and call site**

In `src/components/booking/square-card-on-file-form.tsx`, change the type and call:

```ts
interface SquareCard {
  attach(selector: string): Promise<void>;
  destroy(): void;
  tokenize(
    verificationDetails?: SquareVerificationDetails,
  ): Promise<SquareTokenizeResult>;
}
```

Then change the submission call:

```ts
const tokenizeResult = await cardRef.current.tokenize(verificationDetails);
```

- [ ] **Step 4: Run the focused test again**

Run:

```bash
npx tsx --test src/components/booking/booking-flow.test.ts
```

Expected: PASS.

---

## Task 2: Align public config route with server-side Square service readiness

**Files:**

- Modify: `src/lib/env/private-checkout.ts:84-123, 147-187`
- Modify: `src/lib/env/private-checkout.test.ts`
- Modify: `src/app/api/booking/square/config/route.ts`
- Modify: `src/app/api/booking/square/config/route.test.ts`

- [ ] **Step 1: Add env tests for fully configured card-on-file**

Add tests to `src/lib/env/private-checkout.test.ts` using the existing `runTsx` helper and `cardOnFileConfigScript` constant:

```ts
test("square card-on-file config is unavailable when service booking Square is disabled", () => {
  const env = { ...process.env };

  env.SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED = "true";
  env.SERVICE_BOOKING_SQUARE_ENABLED = "false";
  env.SQUARE_APPLICATION_ID = "sandbox-sq0idb-test";
  env.SQUARE_ENVIRONMENT = "sandbox";
  env.SQUARE_LOCATION_ID = "LOC123";

  const result = runTsx(
    cardOnFileConfigScript.replace(
      "EXPECTED_ASSERTIONS",
      "assert.equal(config, null);",
    ),
    env,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("square card-on-file config returns public values when both card and service flags are enabled", () => {
  const env = { ...process.env };

  env.SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED = "true";
  env.SERVICE_BOOKING_SQUARE_ENABLED = "true";
  env.SQUARE_ENVIRONMENT = "sandbox";
  env.SQUARE_APPLICATION_ID = "sandbox-sq0idb-test";
  env.SQUARE_LOCATION_ID = "LOC123";
  env.SQUARE_ACCESS_TOKEN = "secret-access-token";
  env.SQUARE_WEBHOOK_SIGNATURE_KEY = "secret-webhook-key";
  env.SQUARE_SERVICE_BOOKING_RETURN_URL =
    "https://example.com/booking/confirmation";
  env.SQUARE_SERVICE_BOOKING_WEBHOOK_URL =
    "https://example.com/api/webhooks/square";

  const result = runTsx(
    cardOnFileConfigScript.replace(
      "EXPECTED_ASSERTIONS",
      `
        assert.deepEqual(config, {
          applicationId: "sandbox-sq0idb-test",
          environment: "sandbox",
          locationId: "LOC123",
        });
      `,
    ),
    env,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});
```

- [ ] **Step 2: Run env tests and see the first new case fail**

Run:

```bash
npx tsx --test src/lib/env/private-checkout.test.ts
```

Expected before implementation: config currently returns public config without requiring `SERVICE_BOOKING_SQUARE_ENABLED`, so the disabled service-booking case fails.

- [ ] **Step 3: Require server Square readiness in config helper**

Change `getSquareCardOnFileServiceBookingConfig`:

```ts
export function getSquareCardOnFileServiceBookingConfig(): SquareCardOnFileServiceBookingConfig | null {
  if (!isSquareCardOnFileServiceBookingEnabled()) {
    return null;
  }

  const serviceEnv = getSquareServiceBookingEnv();
  if (serviceEnv === null) {
    return null;
  }

  return {
    environment: serviceEnv.environment,
    applicationId: assertValue(
      process.env.SQUARE_APPLICATION_ID,
      "Missing env var: SQUARE_APPLICATION_ID",
    ),
    locationId: serviceEnv.locationId,
  };
}
```

- [ ] **Step 4: Ensure config route still returns no secrets**

Run:

```bash
npx tsx --test src/app/api/booking/square/config/route.test.ts src/lib/env/private-checkout.test.ts
```

Expected: PASS; public route response contains application ID, environment, location ID, and script URL only.

---

## Task 3: Move no-show policy evidence to the server

**Files:**

- Modify: `src/lib/booking/payments/service-no-show-policy.ts`
- Modify: `src/lib/booking/payments/service-no-show-policy.test.ts`
- Modify: `src/lib/booking/payments/service-card-on-file.ts`
- Modify: `src/lib/booking/payments/service-card-on-file.test.ts`
- Modify: `src/lib/private-db/card-on-file-repository.ts`
- Modify: `src/app/api/booking/card-on-file/route.ts`
- Modify: `src/app/api/booking/card-on-file/route.test.ts`

- [ ] **Step 1: Add canonical policy constants and tests**

In `service-no-show-policy.ts`, export canonical copy:

```ts
export const SERVICE_NO_SHOW_POLICY_TEXT = `I authorize Lash Her to keep my payment card on file for this appointment. I understand that my card may be charged up to the maximum no-show amount shown above in the event of a missed appointment or late cancellation, according to the studio's cancellation policy. No payment will be taken today.`;

export function getCanonicalServiceNoShowPolicyEvidence(input: {
  acceptedAt: Date;
  customerEmail: string;
  customerName: string;
  ipAddress?: string;
  maxChargeCents: number;
  userAgent?: string;
}): ServiceNoShowPolicyAcceptance {
  return buildServiceNoShowPolicyAcceptance({
    accepted: true,
    policyText: SERVICE_NO_SHOW_POLICY_TEXT,
    ...input,
  });
}
```

Add test:

```ts
test("canonical no-show policy evidence hashes server-owned copy and audit fields", () => {
  const evidence = getCanonicalServiceNoShowPolicyEvidence({
    acceptedAt: new Date("2026-06-20T12:00:00Z"),
    customerEmail: "client@example.com",
    customerName: "Client Test",
    ipAddress: "203.0.113.10",
    maxChargeCents: 12500,
    userAgent: "Test Browser",
  });

  assert.equal(evidence.policyVersion, SERVICE_NO_SHOW_POLICY_VERSION);
  assert.equal(
    evidence.policyTextHash,
    hashServiceNoShowPolicyText(SERVICE_NO_SHOW_POLICY_TEXT),
  );
  assert.ok(evidence.ipAddressHash);
  assert.ok(evidence.userAgentHash);
});
```

- [ ] **Step 2: Run policy tests**

Run:

```bash
npx tsx --test src/lib/booking/payments/service-no-show-policy.test.ts
```

Expected: PASS after the new helper is added.

- [ ] **Step 3: Change route request parsing to require only acceptance and amount**

In `src/app/api/booking/card-on-file/route.ts`, keep compatibility with existing client fields but stop trusting them. The route should parse:

```ts
const policy = parsePolicy(body.policy);
```

with this shape:

```ts
function parsePolicy(
  value: unknown,
): CardOnFileBookingRequestBody["policy"] | null {
  if (!isRecord(value) || value.accepted !== true) {
    return null;
  }

  const maxChargeCents = parsePositiveInteger(value.maxChargeCents);
  if (maxChargeCents === null) {
    return null;
  }

  return { accepted: true, maxChargeCents };
}
```

Update `CardOnFileBookingRequestBody` in `service-card-on-file.ts` so `policy` is:

```ts
policy: {
  accepted: true;
  maxChargeCents: number;
}
```

- [ ] **Step 4: Capture privacy-safe audit inputs in the route**

Add helpers in `src/app/api/booking/card-on-file/route.ts`:

```ts
function getClientIpHashInput(req: NextRequest): string | undefined {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = req.headers.get("x-real-ip")?.trim();
  return forwarded && forwarded.length > 0 ? forwarded : realIp || undefined;
}

function getUserAgentHashInput(req: NextRequest): string | undefined {
  const userAgent = req.headers.get("user-agent")?.trim();
  return userAgent && userAgent.length > 0 ? userAgent : undefined;
}
```

Pass these into `runCardOnFileBooking`:

```ts
const result = await dependencies.runCardOnFileBooking({
  ...request,
  ipAddress: getClientIpHashInput(req),
  userAgent: getUserAgentHashInput(req),
});
```

- [ ] **Step 5: Compute policy evidence inside the saga**

In `service-card-on-file.ts`, import `getCanonicalServiceNoShowPolicyEvidence` and replace persisted policy fields:

```ts
const policyEvidence = getCanonicalServiceNoShowPolicyEvidence({
  acceptedAt: now,
  customerEmail: hold.customer.email,
  customerName: hold.customer.name,
  ipAddress: input.ipAddress,
  maxChargeCents: input.policy.maxChargeCents,
  userAgent: input.userAgent,
});

policyAcceptance = await resolvePolicyAcceptance(dependencies.repository, {
  holdId: hold.id,
  policyVersion: policyEvidence.policyVersion,
  policyTextHash: policyEvidence.policyTextHash,
  maxChargeCents: policyEvidence.maxChargeCents,
  currency: policyEvidence.currency,
  customerEmail: policyEvidence.customerEmail,
  customerName: policyEvidence.customerName,
  ipHash: policyEvidence.ipAddressHash,
  userAgentHash: policyEvidence.userAgentHash,
  now,
});
```

Extend repository `persistPolicyAcceptance` input and DB insert with `ipHash` and `userAgentHash`:

```ts
ipHash: input.ipHash,
userAgentHash: input.userAgentHash,
```

- [ ] **Step 6: Add tests for tampered client policy hash**

In `service-card-on-file.test.ts`, update the existing tamper tests or add:

```ts
test("server computes policy hash and ignores client-supplied policy hash fields", async () => {
  const fixture = createCardOnFileFixture();
  const result = await confirmCardOnFileBooking(
    {
      ...fixture.request,
      policy: {
        accepted: true,
        maxChargeCents: fixture.expectedMaxChargeCents,
        policyTextHash: "client-tamper",
        policyVersion: "client-tamper",
      } as never,
    },
    fixture.dependencies,
  );

  assert.equal(result.ok, true);
  assert.equal(
    fixture.repository.policyAcceptances[0]?.policyVersion,
    SERVICE_NO_SHOW_POLICY_VERSION,
  );
});
```

- [ ] **Step 7: Run focused tests**

Run:

```bash
npx tsx --test src/app/api/booking/card-on-file/route.test.ts src/lib/booking/payments/service-card-on-file.test.ts src/lib/booking/payments/service-no-show-policy.test.ts
```

Expected: PASS.

---

## Task 4: Stop accepting and persisting raw billing postal code

**Files:**

- Modify: `src/app/api/booking/card-on-file/route.ts`
- Modify: `src/lib/booking/payments/service-card-on-file.ts`
- Modify: `src/lib/private-db/card-on-file-repository.ts`
- Modify: tests covering those files

- [ ] **Step 1: Add test that client postal code is ignored**

In `src/app/api/booking/card-on-file/route.test.ts`, add:

```ts
test("card-on-file route ignores client billingPostalCode", async () => {
  let received: CardOnFileBookingRequestBody | null = null;
  const { handler } = createHandler({
    async runCardOnFileBooking(input) {
      received = input;
      return {
        ok: true,
        bookingStatus: "booked",
        card: { brand: "VISA", expMonth: 12, expYear: 2030, last4: "4242" },
        holdReference: "hold_public_1",
        noShowChargeStatus: "ready",
      };
    },
  });

  const base = JSON.parse(await createValidRequest().text()) as Record<
    string,
    unknown
  >;
  await handler(
    new NextRequest("http://localhost:3000/api/booking/card-on-file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...base, billingPostalCode: "A1A 1A1" }),
    }),
  );

  assert.equal(received && "billingPostalCode" in received, false);
});
```

- [ ] **Step 2: Remove request parsing and persistence**

Remove `billingPostalCode` from `CardOnFileBookingRequestBody`, route parsing, `createOrReuseSquareCard`, `persistSavedPaymentMethod`, and Square card request construction. The Square card request should no longer set `billing_address` from client input:

```ts
card: {
  customer_id: input.squareCustomer.squareCustomerId,
  cardholder_name: input.cardholderName,
  reference_id: input.hold.publicReference,
},
```

- [ ] **Step 3: Run focused tests**

Run:

```bash
npx tsx --test src/app/api/booking/card-on-file/route.test.ts src/lib/booking/payments/service-card-on-file.test.ts
```

Expected: PASS.

---

## Task 5: Make Square card persistence recoverable after provider success

**Files:**

- Modify: `src/lib/booking/payments/service-card-on-file.ts:717-776`
- Modify: `src/lib/booking/payments/service-card-on-file.test.ts`

- [ ] **Step 1: Add test for post-provider persistence failure with checkpoint recovery**

Add a test to `service-card-on-file.test.ts`:

```ts
test("card save persists Square card checkpoint before local saved-payment insert", async () => {
  const fixture = createCardOnFileFixture();
  fixture.repository.failPersistSavedPaymentMethodOnce = true;

  const first = await confirmCardOnFileBooking(
    fixture.request,
    fixture.dependencies,
  );
  assert.equal(first.ok, false);
  assert.equal(
    fixture.repository.progressByHold.get(fixture.hold.id)?.squareCardId,
    "ccof:test-card",
  );

  fixture.repository.failPersistSavedPaymentMethodOnce = false;
  const retry = await confirmCardOnFileBooking(
    { ...fixture.request, idempotencyKey: "retry-after-card-checkpoint" },
    fixture.dependencies,
  );

  assert.equal(retry.ok, true);
  assert.equal(fixture.squareCards.createCardCalls.length, 1);
});
```

Adjust fixture property names to the existing fake repository and Square card fake names.

- [ ] **Step 2: Save checkpoint immediately after Square createCard returns**

In `createOrReuseSquareCard`, after `createCard` succeeds and before `persistSavedPaymentMethod`, add:

```ts
try {
  await saveCheckpoint(input.repository, input.hold.id, {
    squareCardId: response.card.id,
    squareCardIdempotencyKey: idempotencyKey,
    card: {
      brand: response.card.card_brand,
      expMonth: response.card.exp_month,
      expYear: response.card.exp_year,
      last4: response.card.last_4,
    },
  });
} catch (error) {
  return {
    ok: false,
    error: new CardOnFileInfrastructureError(
      `Square card was created but local checkpoint failed: ${getErrorMessage(error)}`,
    ),
  };
}
```

Keep the later checkpoint after `persistSavedPaymentMethod`, but let it add `savedPaymentMethodId` only.

- [ ] **Step 3: Run focused tests**

Run:

```bash
npx tsx --test src/lib/booking/payments/service-card-on-file.test.ts
```

Expected: PASS.

---

## Task 6: Re-check Calendar event correlation inside the Calendar lock

**Files:**

- Modify: `src/lib/booking/payments/service-card-on-file-calendar-finalizer.ts`
- Modify: `src/lib/booking/payments/service-card-on-file.test.ts`

- [ ] **Step 1: Add regression test for duplicate calendar recovery inside lock**

Add a test around the calendar finalizer fake:

```ts
test("calendar finalizer re-checks existing hold event after acquiring lock", async () => {
  const fixture = createCalendarFinalizerFixture();
  fixture.google.findBookingEventForHoldResults = [
    null,
    "event-existing-after-lock",
  ];

  const result = await fixture.finalizer.finalize({
    hold: fixture.hold,
    now: new Date("2026-06-20T12:00:00Z"),
  });

  assert.deepEqual(result, {
    ok: true,
    googleEventId: "event-existing-after-lock",
  });
  assert.equal(fixture.google.insertBookingEventCalls.length, 0);
});
```

Use the existing test fixture style if the project already has one; otherwise place this in the current `service-card-on-file.test.ts` calendar-finalization section.

- [ ] **Step 2: Re-check inside lock before availability and insert**

In `service-card-on-file-calendar-finalizer.ts`, after lock acquisition and before `isPaidHoldSlotStillAvailable`, add:

```ts
for (const calendarId of calendarIds) {
  const eventId = await googleCalendarModule.findBookingEventForHold({
    calendarId,
    hold,
  });

  if (eventId !== null) {
    return { ok: true, googleEventId: eventId };
  }
}
```

Keep the existing lock lease value in this task. Change only the duplicate-event re-check behavior so the blast radius stays small.

- [ ] **Step 3: Run focused tests and build**

Run:

```bash
npx tsx --test src/lib/booking/payments/service-card-on-file.test.ts
npm run build
```

Expected: tests and build pass.

---

## Plan Self-Review Checklist

- Covers: Web SDK tokenize shape, config flag alignment, canonical server policy evidence, IP/UA hashing, raw postal-code avoidance, Square card checkpoint recovery, Calendar duplicate race.
- Defers by design: admin no-show authorization, charge execution, webhook final financial validation, reconciliation recovery, sandbox certification.
- No production no-show charge capture is enabled by this plan.
