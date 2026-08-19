import {
  createCipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import { Client } from "pg";
import { encode } from "next-auth/jwt";

import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

import { COMMERCE_E2E_MANUAL_POLICY_TEXT } from "./support/commerce-e2e-config";
import { ADMIN_CALENDAR_E2E_AUTH_SECRET } from "./support/admin-calendar-e2e-config";
import {
  PRODUCT_MANUAL_CANCELLATION_POLICY,
  PRODUCT_SHIPPING_US_DDU_CONTRACT,
} from "@/lib/shipping/product-shipping-config";

const enabledMode = process.env.COMMERCE_E2E_ENABLED_MODE === "1";
const cronSecret = "e2e-cron-secret-0123456789-ABCDEFGHIJKLMNOP";
const addressChangeSecret = "e2e-address-change-token-secret-0123456789ABCDEF";
// Derived from the config so the spec cannot drift from the deployed policy /
// disclosure versions the checkout enforces.
const manualPolicyVersion =
  PRODUCT_MANUAL_CANCELLATION_POLICY?.version ??
  "manual-pickup-cancellation-unset";
const usImportDisclosureVersion =
  PRODUCT_SHIPPING_US_DDU_CONTRACT?.disclosure.version ??
  "us-ddu-disclosure-unset";
const manualPolicyHash = createHash("sha256")
  .update(COMMERCE_E2E_MANUAL_POLICY_TEXT, "utf8")
  .digest("hex");

test.describe("enabled database-backed commerce workflows", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(
    !enabledMode,
    "Requires explicitly isolated enabled-mode commerce fixtures.",
  );

  test("enabled Canada checkout completes real quote and payment operation polling", async ({
    page,
    request,
  }) => {
    await page.goto(
      "/checkout?buyNow=1&productId=commerce-e2e-automated-ca&quantity=1",
    );
    await expect(
      page.locator("#main-content").getByText("E2E Canada Lash Kit", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Get shipping rates" }),
    ).toBeDisabled();

    const customer = {
      name: "Enabled Canada Customer",
      email: "enabled-ca@example.invalid",
      phone: "4165550100",
    };
    const shippingAddress = {
      line1: "646 Oakwood Avenue",
      city: "Toronto",
      province: "ON",
      postalCode: "M6E 2Y4",
      country: "Canada",
      countryCode: "CA" as const,
    };
    const items = [{ productId: "commerce-e2e-automated-ca", quantity: 1 }];
    const quoteStart = await request.post("/api/shipping/quotes", {
      data: { customer, items, shippingAddress },
    });
    const pendingQuote = await quoteStart.json();
    expect(quoteStart.status(), JSON.stringify(pendingQuote)).toBe(202);
    expect(["queued", "succeeded"]).toContain(pendingQuote.status);
    if (pendingQuote.status === "queued") await runCommerceWorker(request);
    const quote = await getCompletedQuote(request, pendingQuote);
    expect(quote.rates).toEqual([
      expect.objectContaining({
        amountCents: 1200,
        insured: true,
        tracked: true,
      }),
    ]);

    const checkoutStart = await request.post("/api/checkout", {
      data: {
        customer,
        disclosures: {},
        fulfillmentMode: "automated_shipping",
        items,
        shippingAddress,
        shippingQuote: {
          token: quote.quoteToken,
          fingerprint: quote.fingerprint,
          rateId: quote.rates[0].id,
        },
      },
    });
    const checkoutOperation = await checkoutStart.json();
    expect(checkoutStart.status(), JSON.stringify(checkoutOperation)).toBe(202);
    expect(checkoutOperation).toMatchObject({ status: "queued" });

    await runCommerceWorker(request);
    const checkoutToken = await getReadyCheckoutToken(
      request,
      checkoutOperation.operationId,
    );
    const payment = await validateDeterministicPayment(request, checkoutToken);
    expect(payment.response.status()).toBe(200);
    expect(payment.body.redirectUrl).toContain("/products/confirmation?order=");
    await runCommerceWorker(request);
    await expectProductState(payment.body.orderId, {
      fulfillmentMode: "automated_shipping",
      paymentRiskStatus: "cleared",
      shipmentStatus: "ready_for_staff",
    });

    await page.goto(payment.body.redirectUrl);
    await expect(
      page.getByRole("heading", { name: "Payment Received" }),
    ).toBeVisible();
  });

  test("enabled manual pickup completes real payment initialization and risk clearance", async ({
    page,
    request,
  }) => {
    await page.goto(
      "/checkout?buyNow=1&productId=commerce-e2e-manual&quantity=1",
    );
    await expect(
      page.locator("#main-content").getByText("E2E Manual Pickup Product", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Arrange pickup" }),
    ).toBeVisible();
    await expect(
      page.locator("#main-content").getByText(COMMERCE_E2E_MANUAL_POLICY_TEXT),
    ).toBeVisible();

    const checkoutStart = await request.post("/api/checkout", {
      data: {
        customer: {
          name: "Enabled Pickup Customer",
          email: "enabled-pickup@example.invalid",
          phone: "4165550101",
        },
        disclosures: {
          cancellationPolicyAccepted: true,
          cancellationPolicyTextHash: manualPolicyHash,
          cancellationPolicyVersion: manualPolicyVersion,
        },
        fulfillmentMode: "manual_pickup",
        items: [{ productId: "commerce-e2e-manual", quantity: 1 }],
      },
    });
    const checkoutOperation = await checkoutStart.json();
    expect(checkoutStart.status(), JSON.stringify(checkoutOperation)).toBe(202);
    expect(checkoutOperation).toMatchObject({ status: "queued" });

    await runCommerceWorker(request);
    const checkoutToken = await getReadyCheckoutToken(
      request,
      checkoutOperation.operationId,
    );
    const payment = await validateDeterministicPayment(request, checkoutToken);
    expect(payment.response.status()).toBe(200);
    expect(payment.body.orderId).toMatch(/^lh-/);
    expect(payment.body.redirectUrl).toContain(payment.body.orderId);
    await expectProductState(payment.body.orderId, {
      fulfillmentMode: "manual_pickup",
      manualFulfillmentStatus: "paid_pending_dispatch",
      paymentRiskStatus: "cleared",
      shipmentStatus: null,
    });
  });

  test("address scanner prefetch is non-consuming and explicit exchange submits a high-risk incident", async ({
    page,
    request,
  }) => {
    const fixture = await seedAddressChangeForCanadaOrder();
    const scanner = await request.get(
      `/orders/address-change?token=${encodeURIComponent(fixture.bearerToken)}`,
      { maxRedirects: 0 },
    );
    expect(scanner.status()).toBe(303);
    expect(scanner.headers()["cache-control"]).toContain("no-store");
    await expectAddressChangeState(fixture.requestId, {
      exchanged: false,
      status: "pending_customer",
    });

    await page.context().addCookies([
      {
        name: "lh_address_change_bearer",
        value: fixture.bearerToken,
        domain: "localhost",
        path: "/orders/address-change",
        httpOnly: true,
        sameSite: "Strict",
        secure: false,
      },
    ]);
    await page.goto("/orders/address-change");
    await expect(
      page.getByRole("heading", { name: "Open your address change" }),
    ).toBeVisible();

    const exchange = await request.post("/orders/address-change", {
      form: { action: "exchange" },
      headers: {
        cookie: `lh_address_change_bearer=${fixture.bearerToken}`,
        origin: "http://localhost:3000",
      },
      maxRedirects: 0,
    });
    expect(exchange.status()).toBe(303);
    const sessionToken = readSetCookieValue(
      exchange.headers()["set-cookie"],
      "lh_address_change",
    );
    expect(sessionToken).toBeTruthy();
    await expectAddressChangeState(fixture.requestId, {
      exchanged: true,
      status: "pending_customer",
    });

    await page.context().addCookies([
      {
        name: "lh_address_change",
        value: sessionToken!,
        domain: "localhost",
        path: "/orders/address-change",
        httpOnly: true,
        sameSite: "Strict",
        secure: false,
      },
    ]);
    await page.goto("/orders/address-change");
    await expect(
      page.getByRole("heading", { name: "Change shipping address" }),
    ).toBeVisible();
    await expect(
      page.getByText(/Current destination: Canada, M6E…/),
    ).toBeVisible();

    const submitted = await request.post("/orders/address-change", {
      form: {
        city: "Vancouver",
        countryCode: "CA",
        line1: "701 West Georgia Street",
        line2: "",
        postalCode: "V7Y 1G5",
        province: "BC",
      },
      headers: {
        cookie: `lh_address_change=${sessionToken}`,
        origin: "http://localhost:3000",
      },
    });
    expect(submitted.status()).toBe(200);
    expect(await submitted.text()).toContain("Your address was received");
    await expectHighRiskAddressSubmission(fixture);

    const authenticatedAt = await authenticateCommerceOwner(page);
    const callbackReference = "e2e://callback/original-order-phone";
    const callbackRationale =
      "Original order phone callback confirmed the requested destination.";
    await expectAddressOwnerAction(
      page,
      fixture.requestId,
      authenticatedAt,
      {
        action: "record_phone_callback",
        callbackEvidenceReference: callbackReference,
        rationale: callbackRationale,
      },
      201,
    );

    const addressRationale =
      "Address evidence and callback support the customer-requested change.";
    await expectAddressOwnerAction(
      page,
      fixture.requestId,
      authenticatedAt,
      {
        action: "address_approval",
        callbackEvidenceReference: callbackReference,
        rationale: addressRationale,
        responsibility: "customer",
      },
      202,
    );
    await expireAddressCoolingOff(
      fixture.requestId,
      "address_change",
      "address_approval_proposed",
    );
    await expectAddressOwnerAction(
      page,
      fixture.requestId,
      authenticatedAt,
      {
        action: "address_approval",
        callbackEvidenceReference: callbackReference,
        rationale: addressRationale,
        responsibility: "customer",
      },
      202,
    );

    const fraudRationale =
      "Certified payment evidence supports clearing this address risk incident.";
    await expectAddressOwnerAction(
      page,
      fixture.requestId,
      authenticatedAt,
      {
        action: "fraud_clearance",
        callbackEvidenceReference: "",
        rationale: fraudRationale,
        responsibility: "customer",
      },
      202,
    );
    await expireAddressCoolingOff(
      fixture.requestId,
      "payment_risk_incident",
      "fraud_clearance_proposed",
    );
    await expectAddressOwnerAction(
      page,
      fixture.requestId,
      authenticatedAt,
      {
        action: "fraud_clearance",
        callbackEvidenceReference: "",
        rationale: fraudRationale,
        responsibility: "customer",
      },
      200,
    );
    await expectAddressApprovalComplete(fixture.requestId);
    await seedAddressSignatureConsent(fixture.requestId);

    const firstReconciliation = await applyAddressChange(
      page,
      fixture.requestId,
      202,
    );
    expect(firstReconciliation).toMatchObject({ status: "queued" });
    await runCommerceWorker(request);

    const firstOffer = await applyAddressChange(page, fixture.requestId, 200);
    expect(firstOffer).toMatchObject({
      requiresSupplementalPayment: true,
    });
    const firstObligationId = String(firstOffer.supplementalObligationId);
    await expireAddressSupplementalOffer(fixture.requestId, firstObligationId);
    const expiredOffer = await applyAddressChange(page, fixture.requestId, 200);
    expect(expiredOffer).toMatchObject({
      freshQuoteRequired: true,
      requiresSupplementalPayment: false,
    });

    await runCommerceWorker(request);
    // The stale prepared shipment consumed the prior signature consent, so the
    // fresh-quote re-rate prepares a new shipment that needs its own consent
    // (the customer re-signs for the reissued quote).
    await seedAddressSignatureConsent(fixture.requestId);
    const reprice = await applyAddressChange(page, fixture.requestId, 202);
    expect(reprice).toMatchObject({ status: "queued" });
    await runCommerceWorker(request);
    const reissuedOffer = await applyAddressChange(
      page,
      fixture.requestId,
      200,
    );
    expect(reissuedOffer).toMatchObject({
      requiresSupplementalPayment: true,
    });
    expect(reissuedOffer.supplementalObligationId).not.toBe(firstObligationId);

    await runCommerceWorker(request);
    const supplementalCheckoutToken = await getInitializedObligationToken(
      String(reissuedOffer.supplementalObligationId),
    );
    const supplementalPayment = await validateDeterministicPayment(
      request,
      supplementalCheckoutToken,
    );
    expect(supplementalPayment.response.status()).toBe(200);

    const deleteOldPostage = await applyAddressChange(
      page,
      fixture.requestId,
      200,
    );
    expect(deleteOldPostage.oldPostageReconciliationPending).toBe(true);
    await runCommerceWorker(request);
    const purchaseReplacement = await applyAddressChange(
      page,
      fixture.requestId,
      202,
    );
    expect(purchaseReplacement.preparedPurchasePending).toBe(true);
    await runCommerceWorker(request);
    const adopted = await applyAddressChange(page, fixture.requestId, 200);
    expect(adopted).toMatchObject({
      requiresSupplementalPayment: false,
      refundDecreaseCents: 0,
    });
    await expectAddressAdopted(fixture.requestId, firstObligationId);
  });

  test("replacement inventory fallback route reserves a complete typed full refund", async ({
    page,
    request,
  }) => {
    await authenticateCommerceOwner(page);
    const orderReference = await createFreshCanadaAutomatedOrder(request);
    const fixture =
      await seedInventoryUnavailableReplacementCase(orderReference);
    const response = await page.request.post(
      `/api/admin/shipping-cases/${fixture.caseId}/action`,
      {
        data: { action: "replacement", inventoryConfirmed: false },
        headers: { origin: "http://localhost:3000" },
      },
    );
    const result = await response.json();
    expect(response.status(), JSON.stringify(result)).toBe(202);
    expect(result.id).toBe(fixture.caseId);
    expect(result.refundOperationIds.length).toBeGreaterThan(0);
    await expectInventoryFallbackRefund(fixture, result.refundOperationIds);
  });

  test("replacement attestation prepares and adopts a purchasable labeled generation", async ({
    page,
    request,
  }) => {
    await authenticateCommerceOwner(page);
    const orderReference = await createFreshCanadaAutomatedOrder(request);
    const fixture = await seedSuccessfulReplacementCase(orderReference);
    let firstAttestationId = "";
    for (const line of fixture.lines) {
      const attestation = await page.request.post(
        `/api/admin/shipping-cases/${fixture.caseId}/action`,
        {
          data: {
            action: "attest_inventory",
            expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
            productId: line.productId,
            quantity: line.quantity,
            sku: line.sku,
            ...(line.variantId ? { variantId: line.variantId } : {}),
          },
          headers: { origin: "http://localhost:3000" },
        },
      );
      const body = await attestation.json();
      expect(attestation.status(), JSON.stringify(body)).toBe(200);
      firstAttestationId ||= String(body.id);
    }
    const prepare = await page.request.post(
      `/api/admin/shipping-cases/${fixture.caseId}/action`,
      {
        data: {
          action: "replacement",
          inventoryAttestationId: firstAttestationId,
          inventoryConfirmed: true,
        },
        headers: { origin: "http://localhost:3000" },
      },
    );
    const prepareBody = await prepare.json();
    expect(prepare.status(), JSON.stringify(prepareBody)).toBe(200);
    await runCommerceWorker(request);

    const prepared = await loadPreparedReplacement(fixture.caseId);
    const adoption = await page.request.post(
      `/api/admin/shipping-cases/${fixture.caseId}/action`,
      {
        data: {
          action: "adopt_replacement",
          expectedRemedyStateVersion: prepared.remedyStateVersion,
          expectedSourceStateVersion: prepared.sourceStateVersion,
        },
        headers: { origin: "http://localhost:3000" },
      },
    );
    const adoptionBody = await adoption.json();
    expect(adoption.status(), JSON.stringify(adoptionBody)).toBe(200);
    expect(adoptionBody.id).toBe(prepared.remedyShipmentId);

    const purchase = await page.request.post(
      `/api/admin/orders/${encodeURIComponent(fixture.orderReference)}/shipping/buy`,
      {
        data: {
          expectedStateVersion: prepared.remedyStateVersion,
          measuredWeightGrams: prepared.totalWeightGrams,
          shipDate: new Date().toISOString().slice(0, 10),
          shipmentId: prepared.remedyShipmentId,
        },
        headers: { origin: "http://localhost:3000" },
      },
    );
    const purchaseBody = await purchase.json();
    expect(purchase.status(), JSON.stringify(purchaseBody)).toBe(202);
    await runCommerceWorker(request);
    const purchased = await loadShipmentVersion(prepared.remedyShipmentId);
    expect(purchased.status).toBe("label_ready");

    const label = await page.request.get(
      `/api/admin/orders/${encodeURIComponent(fixture.orderReference)}/shipping/label`,
      {
        params: {
          expectedStateVersion: String(purchased.stateVersion),
          shipmentId: prepared.remedyShipmentId,
        },
      },
    );
    expect(label.status()).toBe(200);
    expect(label.headers()["content-type"]).toBe("application/pdf");
    expect(label.headers()["cache-control"]).toContain("no-store");
    expect(
      Buffer.from(await label.body())
        .subarray(0, 5)
        .toString(),
    ).toBe("%PDF-");
    await expectReplacementAdopted(fixture, prepared.remedyShipmentId);
  });

  test("address cancellation requires exact owner step-up and preserves the active generation", async ({
    page,
  }) => {
    const authenticatedAt = await authenticateCommerceOwner(page);
    const order = await loadLatestReplacementOrder();
    const issued = await page.request.post(
      `/api/admin/orders/${encodeURIComponent(order.orderReference)}/address-change`,
      { headers: { origin: "http://localhost:3000" } },
    );
    const issuedBody = await issued.json();
    expect(issued.status(), JSON.stringify(issuedBody)).toBe(201);
    const requestId = String(issuedBody.id);
    const expectedStateVersion = await getAddressRequestStateVersion(requestId);
    const rationale =
      "Customer withdrew the request before any replacement address was submitted.";
    const evidenceReference = "e2e://address-cancellation/customer-request";
    await installAddressRevocationStepUpProof(page, authenticatedAt, {
      evidenceReference,
      expectedStateVersion,
      orderReference: order.orderReference,
      rationale,
      requestId,
    });
    const revoked = await page.request.delete(
      `/api/admin/orders/${encodeURIComponent(order.orderReference)}/address-change`,
      {
        data: {
          evidenceReference,
          expectedStateVersion,
          rationale,
          requestId,
        },
        headers: { origin: "http://localhost:3000" },
      },
    );
    const revokedBody = await revoked.json();
    expect(revoked.status(), JSON.stringify(revokedBody)).toBe(200);
    expect(revokedBody).toEqual({ revoked: 1 });
    await expectAddressCancellationPreservedActiveGeneration(
      requestId,
      order.activeShipmentId,
    );
  });

  test("admin operation mutation rejects a stale case version and requires conflict refresh", async ({
    page,
    request,
  }) => {
    await authenticateCommerceOwner(page);
    const orderReference = await createFreshCanadaAutomatedOrder(request);
    const fixture = await seedAdminCaseConflict(orderReference);
    await page.goto("/admin/operations");
    const row = page.locator("li").filter({
      has: page.getByRole("heading", {
        name: `Delay case for ${fixture.orderReference}`,
      }),
    });
    await expect(row).toBeVisible();
    await expect(
      row.getByText("Version", { exact: true }).locator("..").locator("dd"),
    ).toHaveText("1");
    await row.getByRole("button", { name: "Update case" }).click();

    await advanceAdminCaseVersion(fixture.caseId);
    await row.getByRole("button", { name: "Submit reviewed action" }).click();
    await expect(row.getByRole("status")).toContainText(
      "Shipping case changed; refresh before retrying",
    );
    await expect(row.getByRole("status")).toContainText(
      "Refresh the queue before retrying",
    );
    await expectAdminCaseConflictPreserved(fixture.caseId);
  });

  test("supplemental offer exchange is explicit and a late payment after pickup is reserved for refund", async ({
    page,
    request,
  }) => {
    const orderReference = await createFreshManualPickupOrder(request);
    const fixture = await seedManualShippingOfferForPickupRace(orderReference);

    const scannerResponse = await request.get(
      `/orders/payment-offer/exchange?token=${encodeURIComponent(fixture.bearerToken)}`,
      { maxRedirects: 0 },
    );
    expect(scannerResponse.status()).toBe(303);
    await expectDecisionNotExchanged(fixture.decisionId);

    await page.context().addCookies([
      {
        name: "lh_supplemental_payment_offer_bearer",
        value: fixture.bearerToken,
        domain: "localhost",
        path: "/orders/payment-offer",
        httpOnly: true,
        sameSite: "Strict",
        secure: false,
      },
    ]);
    await page.goto("/orders/payment-offer/interstitial");
    await expect(
      page.getByRole("heading", { name: "Open your payment offer" }),
    ).toBeVisible();
    const exchange = await request.post("/orders/payment-offer/exchange", {
      headers: {
        cookie: `lh_supplemental_payment_offer_bearer=${fixture.bearerToken}`,
        origin: "http://localhost:3000",
      },
      maxRedirects: 0,
    });
    expect(exchange.status()).toBe(303);
    const sessionToken = readSetCookieValue(
      exchange.headers()["set-cookie"],
      "lh_supplemental_payment_offer",
    );
    expect(sessionToken).toBeTruthy();
    // The production session cookie is Secure. The Playwright web server is
    // intentionally local HTTP, so install the returned opaque session value
    // as a localhost-only cookie after proving the real exchange response.
    await page.context().addCookies([
      {
        name: "lh_supplemental_payment_offer",
        value: sessionToken!,
        domain: "localhost",
        path: "/orders/payment-offer",
        httpOnly: true,
        sameSite: "Strict",
        secure: false,
      },
    ]);
    await page.goto("/orders/payment-offer");
    await expect(
      page.getByRole("heading", { name: "Review your payment offer" }),
    ).toBeVisible();
    const offerContent = page.locator("#main-content");
    await expect(
      offerContent.getByText(fixture.orderReference, { exact: true }),
    ).toBeVisible();
    await expect(
      offerContent.getByText("Agreed manual shipping", { exact: true }),
    ).toBeVisible();
    await expect(
      offerContent.getByText("$10.00", { exact: true }),
    ).toBeVisible();
    await expect(
      offerContent.getByText(fixture.scopeKey, { exact: true }),
    ).toBeVisible();

    await markPickupRaceWinner(fixture.orderDatabaseId, fixture.obligationId);
    const lateCapture = await validateDeterministicPayment(
      request,
      fixture.checkoutToken,
    );
    expect(lateCapture.response.status()).toBe(202);
    expect(lateCapture.body).toMatchObject({
      orderId: fixture.orderReference,
      paymentStatus: "review_required",
      error: "Payment received; fulfillment confirmation is under review.",
    });
    await expectLateSupplementalCaptureReserved(fixture);
  });

  test("enabled U.S. checkout snapshots DDU terms and completes certified payment", async ({
    page,
    request,
  }) => {
    await page.goto(
      "/checkout?buyNow=1&productId=commerce-e2e-automated-us&quantity=1",
    );
    await expect(
      page.locator("#main-content").getByText("E2E U.S. DDU Lash Kit", {
        exact: true,
      }),
    ).toBeVisible();

    const customer = {
      name: "Enabled U.S. Customer",
      email: "enabled-us@example.invalid",
      phone: "2125550100",
    };
    const shippingAddress = {
      line1: "350 Fifth Avenue",
      city: "New York",
      province: "NY",
      postalCode: "10118",
      country: "United States",
      countryCode: "US" as const,
    };
    const items = [{ productId: "commerce-e2e-automated-us", quantity: 1 }];
    const quoteStart = await request.post("/api/shipping/quotes", {
      data: { customer, items, shippingAddress },
    });
    const pendingQuote = await quoteStart.json();
    expect(quoteStart.status(), JSON.stringify(pendingQuote)).toBe(202);
    expect(pendingQuote).toMatchObject({
      usImportDisclosureVersion,
      usImportTerms: "DDU",
    });
    expect(["queued", "succeeded"]).toContain(pendingQuote.status);
    if (pendingQuote.status === "queued") await runCommerceWorker(request);
    const quote = await getCompletedQuote(request, pendingQuote);
    expect(quote).toMatchObject({
      usImportDisclosureVersion,
      usImportTerms: "DDU",
    });
    expect(quote.rates).toEqual([
      expect.objectContaining({ insured: true, tracked: true }),
    ]);

    const checkoutStart = await request.post("/api/checkout", {
      data: {
        customer,
        disclosures: {
          usImportDisclosureText: quote.usImportDisclosureText,
          usImportDisclosureVersion: quote.usImportDisclosureVersion,
          usImportTerms: quote.usImportTerms,
        },
        fulfillmentMode: "automated_shipping",
        items,
        shippingAddress,
        shippingQuote: {
          token: quote.quoteToken,
          fingerprint: quote.fingerprint,
          rateId: quote.rates[0].id,
        },
      },
    });
    const checkoutOperation = await checkoutStart.json();
    expect(checkoutStart.status(), JSON.stringify(checkoutOperation)).toBe(202);
    await runCommerceWorker(request);
    const checkoutToken = await getReadyCheckoutToken(
      request,
      checkoutOperation.operationId,
    );
    const payment = await validateDeterministicPayment(request, checkoutToken);
    expect(payment.response.status()).toBe(200);
    await runCommerceWorker(request);
    await expectProductState(payment.body.orderId, {
      fulfillmentMode: "automated_shipping",
      paymentRiskStatus: "cleared",
      shipmentStatus: "ready_for_staff",
    });
  });

  test("tracking exception recovers to delivery, sends durable emails, and records the provider return", async ({
    page,
    request,
  }) => {
    await authenticateCommerceOwner(page);
    const fixture = await loadUnitedStatesShipment();
    const purchase = await page.request.post(
      `/api/admin/orders/${encodeURIComponent(fixture.orderReference)}/shipping/buy`,
      {
        data: {
          expectedStateVersion: fixture.stateVersion,
          measuredWeightGrams: 240,
          shipDate: new Date().toISOString().slice(0, 10),
          shipmentId: fixture.shipmentId,
        },
        headers: { origin: "http://localhost:3000" },
      },
    );
    const purchaseBody = await purchase.json();
    expect(purchase.status(), JSON.stringify(purchaseBody)).toBe(202);
    await runCommerceWorker(request);
    await expectShipmentStatus(fixture.shipmentId, "label_ready");

    await advanceShipmentTrackingTo(request, fixture.shipmentId, "exception");
    await runCustomerEmailWorker(request);
    await expectShipmentEmailCompleted(fixture.shipmentId, "exception");

    await advanceShipmentTrackingTo(request, fixture.shipmentId, "in_transit");

    await advanceShipmentTrackingTo(request, fixture.shipmentId, "delivered");
    await runCustomerEmailWorker(request);
    await expectShipmentEmailCompleted(fixture.shipmentId, "delivered");

    // Prior serial tests leave queued refunds against non-numeric E2E fixture
    // transaction ids; the global policy worker correctly settles those to
    // manual_review on its first pass (reported as failures → 503). That
    // backlog is unrelated to this test's provider-return concern, so drain it
    // first, then assert a clean pass that still re-observes the return.
    const policySettle = await request.get("/api/cron/shipping-policy", {
      headers: { authorization: `Bearer ${cronSecret}` },
    });
    expect([200, 503]).toContain(policySettle.status());
    const policyRun = await request.get("/api/cron/shipping-policy", {
      headers: { authorization: `Bearer ${cronSecret}` },
    });
    const policyBody = await policyRun.json();
    expect(policyRun.status(), JSON.stringify(policyBody)).toBe(200);
    await expectProviderReturnRecorded(fixture);
  });
});

async function runCommerceWorker(request: APIRequestContext): Promise<void> {
  const response = await request.get("/api/cron/chitchats-shipping", {
    headers: { authorization: `Bearer ${cronSecret}` },
  });
  expect(response.status()).toBe(200);
}

async function runCustomerEmailWorker(
  request: APIRequestContext,
): Promise<void> {
  // The cron claims a bounded batch (default 10) per invocation. By the last
  // serial test a backlog of prior-order confirmation emails has accumulated,
  // so a single call would not reach the just-enqueued notification. Drain the
  // outbox the way repeated cron ticks would in production.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await request.get("/api/cron/customer-email-outbox", {
      headers: { authorization: `Bearer ${cronSecret}` },
    });
    const body = await response.text();
    expect(response.status(), body).toBe(200);
    const result = JSON.parse(body) as { claimed: number };
    if (result.claimed === 0) return;
  }
}

async function getCompletedQuote(
  request: APIRequestContext,
  pending: {
    operationId: string;
    quoteToken: string;
  },
): Promise<{
  fingerprint: string;
  quoteToken: string;
  rates: Array<{
    id: string;
    amountCents: number;
    insured: boolean;
    tracked: boolean;
  }>;
  usImportDisclosureText?: string;
  usImportDisclosureVersion?: string;
  usImportTerms?: "DDU";
}> {
  const response = await request.get("/api/shipping/quotes", {
    params: {
      operationId: pending.operationId,
      quoteToken: pending.quoteToken,
    },
  });
  expect(response.status()).toBe(200);
  return response.json();
}

async function getReadyCheckoutToken(
  request: APIRequestContext,
  operationId: string,
): Promise<string> {
  const response = await request.get(
    `/api/checkout/payment-operations/${encodeURIComponent(operationId)}`,
  );
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ operationId, status: "ready" });
  expect(body.checkoutToken).toMatch(/^e2e_checkout_\d+_\d+$/);
  return body.checkoutToken;
}

async function validateDeterministicPayment(
  request: APIRequestContext,
  checkoutToken: string,
): Promise<{
  response: Awaited<ReturnType<APIRequestContext["post"]>>;
  body: { orderId: string; redirectUrl: string };
}> {
  const match = /^e2e_checkout_(\d+)_(\d+)$/.exec(checkoutToken);
  if (!match) throw new Error("Unexpected deterministic checkout token");
  const sequence = Number(match[1]);
  const amountCents = Number(match[2]);
  const data = {
    transactionId: `e2e_transaction_${sequence}_${amountCents}`,
    amount: amountCents / 100,
    currency: "CAD",
    invoiceId: 800000 + sequence,
    invoiceNumber: `E2E-INV-${sequence}`,
    transactionType: "purchase",
    status: "APPROVED",
    avsResponse: "Y",
    cvvResponse: "M",
  };
  const secret = `e2e_secret_${sequence}_${amountCents}_0123456789abcdef`;
  const hash = createHash("sha256")
    .update(`${JSON.stringify(data)}${secret}`, "utf8")
    .digest("hex");
  const response = await request.post("/api/checkout/validate-payment", {
    data: { checkoutToken, data, hash },
  });
  return { response, body: await response.json() };
}

async function expectProductState(
  orderId: string,
  expected: {
    fulfillmentMode: "automated_shipping" | "manual_pickup";
    manualFulfillmentStatus?: string;
    paymentRiskStatus: "cleared";
    shipmentStatus: string | null;
  },
): Promise<void> {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TEST_DATABASE_URL is required");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query<{
      fulfillment_mode: string;
      manual_fulfillment_status: string | null;
      payment_risk_status: string;
      shipment_status: string | null;
    }>(
      `select o.fulfillment_mode, o.manual_fulfillment_status,
              o.payment_risk_status, s.status as shipment_status
       from checkout_orders o
       left join product_shipments s on s.id = o.active_fulfillment_shipment_id
       where o.order_id = $1`,
      [orderId],
    );
    expect(result.rows).toEqual([
      expect.objectContaining({
        fulfillment_mode: expected.fulfillmentMode,
        manual_fulfillment_status: expected.manualFulfillmentStatus ?? null,
        payment_risk_status: expected.paymentRiskStatus,
        shipment_status: expected.shipmentStatus,
      }),
    ]);
  } finally {
    await client.end();
  }
}

async function seedAddressChangeForCanadaOrder(): Promise<{
  bearerToken: string;
  orderDatabaseId: string;
  requestId: string;
}> {
  const client = await connectTestDatabase();
  try {
    const order = await client.query<{
      id: string;
      active_fulfillment_shipment_id: string | null;
      shipping_address: Record<string, unknown>;
    }>(
      `select id, active_fulfillment_shipment_id, shipping_address
       from checkout_orders
       where customer_email = 'enabled-ca@example.invalid'
         and status = 'paid'
       order by created_at desc
       limit 1`,
    );
    expect(order.rows).toHaveLength(1);
    const current = order.rows[0]!;
    const shipment = current.active_fulfillment_shipment_id
      ? await client.query<{ state_version: number }>(
          `select state_version from product_shipments where id = $1`,
          [current.active_fulfillment_shipment_id],
        )
      : { rows: [] as Array<{ state_version: number }> };
    await client.query(
      `update product_order_address_change_requests
       set status = 'revoked', revoked_at = now(), state_version = state_version + 1
       where order_id = $1
         and status in ('pending_customer', 'submitted', 'risk_review', 'approved')`,
      [current.id],
    );
    const bearerToken = randomBytes(32).toString("base64url");
    const tokenHash = createHmac("sha256", addressChangeSecret)
      .update(bearerToken)
      .digest("hex");
    const inserted = await client.query<{ id: string }>(
      `insert into product_order_address_change_requests (
         order_id, shipment_id, expected_source_shipment_id,
         expected_source_shipment_state_version, original_address,
         token_hash, expires_at
       ) values ($1, $2, $2, $3, $4::jsonb, $5, now() + interval '30 minutes')
       returning id`,
      [
        current.id,
        current.active_fulfillment_shipment_id,
        shipment.rows[0]?.state_version ?? null,
        JSON.stringify(current.shipping_address),
        tokenHash,
      ],
    );
    return {
      bearerToken,
      orderDatabaseId: current.id,
      requestId: inserted.rows[0]!.id,
    };
  } finally {
    await client.end();
  }
}

async function expectAddressChangeState(
  requestId: string,
  expected: { exchanged: boolean; status: string },
): Promise<void> {
  const client = await connectTestDatabase();
  try {
    const result = await client.query<{
      exchanged: boolean;
      status: string;
    }>(
      `select exchanged_at is not null as exchanged, status
       from product_order_address_change_requests
       where id = $1`,
      [requestId],
    );
    expect(result.rows).toEqual([
      { exchanged: expected.exchanged, status: expected.status },
    ]);
  } finally {
    await client.end();
  }
}

async function expectHighRiskAddressSubmission(fixture: {
  orderDatabaseId: string;
  requestId: string;
}): Promise<void> {
  const client = await connectTestDatabase();
  try {
    const result = await client.query<{
      country_code: string;
      payment_risk_status: string;
      risk_flags: string[];
      risk_incident_id: string | null;
      status: string;
    }>(
      `select request.status, request.risk_flags,
              request.risk_incident_id,
              request.proposed_address->>'countryCode' as country_code,
              orders.payment_risk_status
       from product_order_address_change_requests request
       join checkout_orders orders on orders.id = request.order_id
       where request.id = $1 and orders.id = $2`,
      [fixture.requestId, fixture.orderDatabaseId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      country_code: "CA",
      payment_risk_status: "review_required",
      status: "risk_review",
    });
    expect(result.rows[0]!.risk_incident_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f-]{27}$/,
    );
    expect(result.rows[0]!.risk_flags).toContain("province_change");
  } finally {
    await client.end();
  }
}

async function authenticateCommerceOwner(
  page: import("@playwright/test").Page,
) {
  const maxAge = 8 * 60 * 60;
  const authenticatedAtSeconds = Math.floor(Date.now() / 1_000);
  const value = await encode({
    maxAge,
    salt: "authjs.session-token",
    secret: ADMIN_CALENDAR_E2E_AUTH_SECRET,
    token: {
      email: "commerce-e2e-owner@example.invalid",
      adminAuthenticatedAt: authenticatedAtSeconds,
      googleEmailVerified: true,
      name: "Nataliea Lavoie",
      providerUserId: "commerce-e2e-owner",
      sub: "commerce-e2e-owner",
    },
  });
  await page.context().addCookies([
    {
      domain: "localhost",
      expires: Math.floor(Date.now() / 1000) + maxAge,
      httpOnly: true,
      name: "authjs.session-token",
      path: "/",
      sameSite: "Lax",
      secure: false,
      value,
    },
  ]);
  return new Date(authenticatedAtSeconds * 1_000);
}

type AddressOwnerActionPayload = {
  action: "address_approval" | "fraud_clearance" | "record_phone_callback";
  callbackEvidenceReference: string;
  rationale: string;
  responsibility?: "customer" | "lash_her";
};

async function expectAddressOwnerAction(
  page: Page,
  requestId: string,
  authenticatedAt: Date,
  payload: AddressOwnerActionPayload,
  expectedStatus: number,
): Promise<Record<string, unknown>> {
  const expectedStateVersion = await getAddressRequestStateVersion(requestId);
  const exactPayload = { ...payload, expectedStateVersion };
  await installAddressStepUpProof(
    page,
    requestId,
    authenticatedAt,
    exactPayload,
  );
  const response = await page.request.post(
    `/api/admin/address-changes/${requestId}/approve`,
    {
      data: exactPayload,
      headers: { origin: "http://localhost:3000" },
    },
  );
  const body = (await response.json()) as Record<string, unknown>;
  expect(response.status(), JSON.stringify(body)).toBe(expectedStatus);
  return body;
}

async function installAddressStepUpProof(
  page: Page,
  requestId: string,
  authenticatedAt: Date,
  payload: AddressOwnerActionPayload & { expectedStateVersion: number },
): Promise<void> {
  const client = await connectTestDatabase();
  const token = randomBytes(32).toString("base64url");
  try {
    const actor = await client.query<{ id: string }>(
      `select id from admin_users where provider_user_id = 'commerce-e2e-owner'`,
    );
    expect(actor.rows).toHaveLength(1);
    const target = createFixtureStepUpTarget({
      action: payload.action,
      callbackEvidenceReference: payload.callbackEvidenceReference,
      expectedStateVersion: payload.expectedStateVersion,
      rationale: payload.rationale,
      requestId,
      responsibility: payload.responsibility ?? null,
    });
    await client.query(
      `insert into admin_step_up_proofs (
         nonce_hash, actor_admin_user_id, action, target,
         authenticated_at, expires_at
       ) values (
         $1, $2, $3, $4, $5::timestamptz,
         $5::timestamptz + interval '5 minutes'
       )`,
      [
        createHash("sha256").update(token).digest("hex"),
        actor.rows[0]!.id,
        `address:${payload.action}`,
        target,
        authenticatedAt,
      ],
    );
  } finally {
    await client.end();
  }
  await page.context().addCookies([
    {
      domain: "localhost",
      expires: Math.floor(authenticatedAt.getTime() / 1_000) + 5 * 60,
      httpOnly: true,
      name: "lash_admin_step_up_proof",
      path: "/",
      sameSite: "Strict",
      secure: false,
      value: token,
    },
  ]);
}

async function installAddressRevocationStepUpProof(
  page: Page,
  authenticatedAt: Date,
  payload: {
    evidenceReference: string;
    expectedStateVersion: number;
    orderReference: string;
    rationale: string;
    requestId: string;
  },
): Promise<void> {
  const client = await connectTestDatabase();
  const token = randomBytes(32).toString("base64url");
  try {
    const actor = await client.query<{ id: string }>(
      `select id from admin_users where provider_user_id = 'commerce-e2e-owner'`,
    );
    expect(actor.rows).toHaveLength(1);
    const target = createFixtureStepUpTarget({ action: "revoke", ...payload });
    await client.query(
      `insert into admin_step_up_proofs (
         nonce_hash, actor_admin_user_id, action, target,
         authenticated_at, expires_at
       ) values (
         $1, $2, 'address:revoke', $3, $4::timestamptz,
         $4::timestamptz + interval '5 minutes'
       )`,
      [
        createHash("sha256").update(token).digest("hex"),
        actor.rows[0]!.id,
        target,
        authenticatedAt,
      ],
    );
  } finally {
    await client.end();
  }
  await page.context().addCookies([
    {
      domain: "localhost",
      expires: Math.floor(authenticatedAt.getTime() / 1_000) + 5 * 60,
      httpOnly: true,
      name: "lash_admin_step_up_proof",
      path: "/",
      sameSite: "Strict",
      secure: false,
      value: token,
    },
  ]);
}

function createFixtureStepUpTarget(scope: unknown): string {
  return `sha256:${createHash("sha256")
    .update("lash-her/admin-step-up-target/v1\0", "utf8")
    .update(stableStepUpJson(scope), "utf8")
    .digest("hex")}`;
}

function stableStepUpJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStepUpJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStepUpJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("Invalid step-up fixture value");
}

async function getAddressRequestStateVersion(
  requestId: string,
): Promise<number> {
  const client = await connectTestDatabase();
  try {
    const result = await client.query<{ state_version: number }>(
      `select state_version
       from product_order_address_change_requests
       where id = $1`,
      [requestId],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0]!.state_version;
  } finally {
    await client.end();
  }
}

async function expireAddressCoolingOff(
  requestId: string,
  targetType: "address_change" | "payment_risk_incident",
  action: "address_approval_proposed" | "fraud_clearance_proposed",
): Promise<void> {
  const client = await connectTestDatabase();
  try {
    const targetIdSql =
      targetType === "address_change"
        ? `$1`
        : `(select risk_incident_id::text from product_order_address_change_requests where id = $1)`;
    const result = await client.query(
      `update fulfillment_owner_actions
       set cooling_off_until = now() - interval '1 second'
       where target_type = $2
         and target_id = ${targetIdSql}
         and action = $3`,
      [requestId, targetType, action],
    );
    expect(result.rowCount).toBe(1);
  } finally {
    await client.end();
  }
}

async function expectAddressApprovalComplete(requestId: string): Promise<void> {
  const client = await connectTestDatabase();
  try {
    const result = await client.query<{
      payment_risk_status: string;
      status: string;
    }>(
      `select requests.status, orders.payment_risk_status
       from product_order_address_change_requests requests
       join checkout_orders orders on orders.id = requests.order_id
       where requests.id = $1`,
      [requestId],
    );
    expect(result.rows).toEqual([
      { payment_risk_status: "cleared", status: "approved" },
    ]);
    const actions = await client.query<{ action: string }>(
      `select actions.action
       from fulfillment_owner_actions actions
       where actions.action in (
         'original_order_phone_callback_recorded',
         'address_approval_executed',
         'fraud_clearance_executed'
       ) and (
         (actions.target_type = 'address_change' and actions.target_id = $1::text)
         or actions.target_id = (
           select risk_incident_id::text
           from product_order_address_change_requests
           where id = $1::uuid
         )
       )`,
      [requestId],
    );
    expect(new Set(actions.rows.map((row) => row.action))).toEqual(
      new Set([
        "original_order_phone_callback_recorded",
        "address_approval_executed",
        "fraud_clearance_executed",
      ]),
    );
  } finally {
    await client.end();
  }
}

async function seedAddressSignatureConsent(requestId: string): Promise<void> {
  const client = await connectTestDatabase();
  try {
    const row = await client.query<{
      order_id: string;
      source_shipment_id: string;
    }>(
      `select order_id,
              coalesce(expected_source_shipment_id, shipment_id)
                as source_shipment_id
       from product_order_address_change_requests
       where id = $1`,
      [requestId],
    );
    expect(row.rows).toHaveLength(1);
    const sourceShipmentId = row.rows[0]!.source_shipment_id;
    const scopeKey = `address-change/${requestId}/shipment/${sourceShipmentId}/signature`;
    const proposedConditions = {
      requestId,
      sourceShipmentId,
      signatureRequired: true,
    };
    // Idempotent: each prepared shipment consumes the signature consent, so a
    // re-rate needs the consent re-provided. On the second call the existing
    // (now consumed) decision is re-validated rather than duplicated, which the
    // unique (order_id, scope_key, scope_version) index would otherwise reject.
    await client.query(
      `insert into product_order_customer_decisions (
         order_id, shipment_id, kind, scope_key, proposed_conditions,
         proposed_conditions_hash, allowed_outcomes, selected_outcome,
         token_hash, status, expires_at, exchanged_at, selected_at
       ) values (
         $1, $2, 'signature_requirement', $3, $4::jsonb, $5,
         '["accept_signature"]'::jsonb, 'accept_signature', $6,
         'selected', now() + interval '1 hour', now(), now()
       )
       on conflict (order_id, scope_key, scope_version) do update set
         status = 'selected',
         selected_outcome = 'accept_signature',
         consumed_at = null,
         superseded_at = null,
         processed_at = null,
         expires_at = now() + interval '1 hour',
         exchanged_at = now(),
         selected_at = now()`,
      [
        row.rows[0]!.order_id,
        sourceShipmentId,
        scopeKey,
        JSON.stringify(proposedConditions),
        hashDecisionConditions(scopeKey, proposedConditions),
        createHash("sha256").update(randomBytes(32)).digest("hex"),
      ],
    );
  } finally {
    await client.end();
  }
}

async function applyAddressChange(
  page: Page,
  requestId: string,
  expectedStatus: number,
): Promise<Record<string, unknown>> {
  const expectedStateVersion = await getAddressRequestStateVersion(requestId);
  const authenticatedAt = await authenticateCommerceOwner(page);
  await installAddressApplyStepUpProof(
    page,
    requestId,
    expectedStateVersion,
    authenticatedAt,
  );
  const response = await page.request.post(
    `/api/admin/address-changes/${requestId}/apply`,
    {
      data: { expectedStateVersion },
      headers: { origin: "http://localhost:3000" },
    },
  );
  const body = (await response.json()) as Record<string, unknown>;
  expect(response.status(), JSON.stringify(body)).toBe(expectedStatus);
  return body;
}

async function installAddressApplyStepUpProof(
  page: Page,
  requestId: string,
  expectedStateVersion: number,
  authenticatedAt: Date,
): Promise<void> {
  const client = await connectTestDatabase();
  const token = randomBytes(32).toString("base64url");
  try {
    const actor = await client.query<{ id: string }>(
      `select id from admin_users where provider_user_id = 'commerce-e2e-owner'`,
    );
    expect(actor.rows).toHaveLength(1);
    const target = createFixtureStepUpTarget(
      JSON.stringify({ requestId, expectedStateVersion }),
    );
    await client.query(
      `insert into admin_step_up_proofs (
         nonce_hash, actor_admin_user_id, action, target,
         authenticated_at, expires_at
       ) values (
         $1, $2, 'fulfillment.address_change_apply', $3,
         $4::timestamptz, $4::timestamptz + interval '5 minutes'
       )`,
      [
        createHash("sha256").update(token).digest("hex"),
        actor.rows[0]!.id,
        target,
        authenticatedAt,
      ],
    );
  } finally {
    await client.end();
  }
  await page.context().addCookies([
    {
      domain: "localhost",
      expires: Math.floor(authenticatedAt.getTime() / 1_000) + 5 * 60,
      httpOnly: true,
      name: "lash_admin_step_up_proof",
      path: "/",
      sameSite: "Strict",
      secure: false,
      value: token,
    },
  ]);
}

async function expireAddressSupplementalOffer(
  requestId: string,
  obligationId: string,
): Promise<void> {
  const client = await connectTestDatabase();
  try {
    await client.query(
      `update order_payment_obligations
       set expires_at = now() - interval '1 second'
       where id = $1 and purpose = 'address_increase' and status = 'pending'`,
      [obligationId],
    );
    await client.query(
      `update product_order_customer_decisions
       set expires_at = now() - interval '1 second'
       where order_id = (
         select order_id from product_order_address_change_requests where id = $1
       ) and scope_key = $2 and status = 'pending'`,
      [requestId, `supplemental-payment/${obligationId}`],
    );
  } finally {
    await client.end();
  }
}

async function getInitializedObligationToken(
  obligationId: string,
): Promise<string> {
  const client = await connectTestDatabase();
  try {
    const result = await client.query<{
      initialization_status: string;
      provider_checkout_id: string | null;
    }>(
      `select initialization_status, provider_checkout_id
       from order_payment_obligations where id = $1`,
      [obligationId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.initialization_status).toBe("ready");
    expect(result.rows[0]!.provider_checkout_id).toMatch(/^e2e_checkout_/);
    return result.rows[0]!.provider_checkout_id!;
  } finally {
    await client.end();
  }
}

async function expectAddressAdopted(
  requestId: string,
  supersededObligationId: string,
): Promise<void> {
  const client = await connectTestDatabase();
  try {
    const result = await client.query<{
      active_fulfillment_shipment_id: string;
      old_postage_outcome: string;
      prepared_shipment_id: string;
      reconciliation_state: string;
      status: string;
      superseded_status: string;
    }>(
      `select requests.status, requests.reconciliation_state,
              requests.old_postage_outcome, requests.prepared_shipment_id,
              orders.active_fulfillment_shipment_id,
              old_obligation.status as superseded_status
       from product_order_address_change_requests requests
       join checkout_orders orders on orders.id = requests.order_id
       join order_payment_obligations old_obligation
         on old_obligation.id = $2
       where requests.id = $1`,
      [requestId, supersededObligationId],
    );
    expect(result.rows).toEqual([
      expect.objectContaining({
        old_postage_outcome: "delete_confirmed",
        reconciliation_state: "adopted",
        status: "applied",
        superseded_status: "superseded",
      }),
    ]);
    expect(result.rows[0]!.active_fulfillment_shipment_id).toBe(
      result.rows[0]!.prepared_shipment_id,
    );
  } finally {
    await client.end();
  }
}

async function loadLatestReplacementOrder(): Promise<{
  activeShipmentId: string;
  orderReference: string;
}> {
  const client = await connectTestDatabase();
  try {
    const result = await client.query<{
      active_fulfillment_shipment_id: string;
      order_id: string;
    }>(
      `select order_id, active_fulfillment_shipment_id
       from checkout_orders
       where customer_email like 'replacement-%@example.invalid'
         and status = 'paid'
         and active_fulfillment_shipment_id is not null
       order by created_at desc
       limit 1`,
    );
    expect(result.rows).toHaveLength(1);
    return {
      activeShipmentId: result.rows[0]!.active_fulfillment_shipment_id,
      orderReference: result.rows[0]!.order_id,
    };
  } finally {
    await client.end();
  }
}

async function expectAddressCancellationPreservedActiveGeneration(
  requestId: string,
  activeShipmentId: string,
): Promise<void> {
  const client = await connectTestDatabase();
  try {
    const result = await client.query<{
      active_fulfillment_shipment_id: string;
      action_count: number;
      status: string;
    }>(
      `select requests.status, orders.active_fulfillment_shipment_id,
              (select count(*)::int
               from fulfillment_owner_actions actions
               where actions.target_type = 'address_change'
                 and actions.target_id = requests.id::text
                 and actions.action = 'address_change_revocation_executed') as action_count
       from product_order_address_change_requests requests
       join checkout_orders orders on orders.id = requests.order_id
       where requests.id = $1`,
      [requestId],
    );
    expect(result.rows).toEqual([
      {
        action_count: 1,
        active_fulfillment_shipment_id: activeShipmentId,
        status: "revoked",
      },
    ]);
  } finally {
    await client.end();
  }
}

async function createFreshCanadaAutomatedOrder(
  request: APIRequestContext,
): Promise<string> {
  const suffix = randomBytes(6).toString("hex");
  const customer = {
    name: "Replacement Workflow Customer",
    email: `replacement-${suffix}@example.invalid`,
    phone: "4165550199",
  };
  const shippingAddress = {
    line1: "646 Oakwood Avenue",
    city: "Toronto",
    province: "ON",
    postalCode: "M6E 2Y4",
    country: "Canada",
    countryCode: "CA" as const,
  };
  const items = [{ productId: "commerce-e2e-automated-ca", quantity: 1 }];
  const quoteStart = await request.post("/api/shipping/quotes", {
    data: { customer, items, shippingAddress },
  });
  const pendingQuote = await quoteStart.json();
  expect(quoteStart.status(), JSON.stringify(pendingQuote)).toBe(202);
  if (pendingQuote.status === "queued") await runCommerceWorker(request);
  const quote = await getCompletedQuote(request, pendingQuote);
  const checkoutStart = await request.post("/api/checkout", {
    data: {
      customer,
      disclosures: {},
      fulfillmentMode: "automated_shipping",
      items,
      shippingAddress,
      shippingQuote: {
        token: quote.quoteToken,
        fingerprint: quote.fingerprint,
        rateId: quote.rates[0]!.id,
      },
    },
  });
  const checkoutOperation = await checkoutStart.json();
  expect(checkoutStart.status(), JSON.stringify(checkoutOperation)).toBe(202);
  await runCommerceWorker(request);
  const checkoutToken = await getReadyCheckoutToken(
    request,
    checkoutOperation.operationId,
  );
  const payment = await validateDeterministicPayment(request, checkoutToken);
  expect(payment.response.status()).toBe(200);
  await runCommerceWorker(request);
  await expectProductState(payment.body.orderId, {
    fulfillmentMode: "automated_shipping",
    paymentRiskStatus: "cleared",
    shipmentStatus: "ready_for_staff",
  });
  return payment.body.orderId;
}

async function createFreshManualPickupOrder(
  request: APIRequestContext,
): Promise<string> {
  const suffix = randomBytes(6).toString("hex");
  const checkoutStart = await request.post("/api/checkout", {
    data: {
      customer: {
        name: "Supplemental Pickup Race Customer",
        email: `pickup-race-${suffix}@example.invalid`,
        phone: "4165550188",
      },
      disclosures: {
        cancellationPolicyAccepted: true,
        cancellationPolicyTextHash: manualPolicyHash,
        cancellationPolicyVersion: manualPolicyVersion,
      },
      fulfillmentMode: "manual_pickup",
      items: [{ productId: "commerce-e2e-manual", quantity: 1 }],
    },
  });
  const checkoutOperation = await checkoutStart.json();
  expect(checkoutStart.status(), JSON.stringify(checkoutOperation)).toBe(202);
  await runCommerceWorker(request);
  const checkoutToken = await getReadyCheckoutToken(
    request,
    checkoutOperation.operationId,
  );
  const payment = await validateDeterministicPayment(request, checkoutToken);
  expect(payment.response.status()).toBe(200);
  await expectProductState(payment.body.orderId, {
    fulfillmentMode: "manual_pickup",
    manualFulfillmentStatus: "paid_pending_dispatch",
    paymentRiskStatus: "cleared",
    shipmentStatus: null,
  });
  return payment.body.orderId;
}

type ReplacementLineFixture = {
  productId: string;
  quantity: number;
  sku: string;
  variantId: string | null;
};

async function seedSuccessfulReplacementCase(orderReference: string): Promise<{
  caseId: string;
  lines: ReplacementLineFixture[];
  orderDatabaseId: string;
  orderReference: string;
  sourceShipmentId: string;
}> {
  const client = await connectTestDatabase();
  try {
    const order = await client.query<{
      active_fulfillment_shipment_id: string;
      id: string;
      line_items: ReplacementLineFixture[];
    }>(
      `select id, active_fulfillment_shipment_id, line_items
       from checkout_orders
       where order_id = $1 and status = 'paid'
         and active_fulfillment_shipment_id is not null`,
      [orderReference],
    );
    expect(order.rows).toHaveLength(1);
    const current = order.rows[0]!;
    const remedyDeadlineAt = new Date(Date.now() + 2 * 24 * 60 * 60_000);
    const inserted = await client.query<{ id: string }>(
      `insert into product_shipping_cases (
         order_id, shipment_id, source_shipment_id, type, status,
         cause, customer_update_due_at, remedy_deadline_at
       ) values (
         $1, $2, $2, 'loss', 'waiting_customer',
         'Customer selected a replacement in the signed remedy workflow.',
         now() + interval '2 hours', $3
       ) returning id`,
      [current.id, current.active_fulfillment_shipment_id, remedyDeadlineAt],
    );
    const caseId = inserted.rows[0]!.id;
    const scopeKey = `loss_damage_remedy/${caseId}/${remedyDeadlineAt.toISOString()}`;
    const proposedConditions = {
      caseId,
      remedyDeadlineAt: remedyDeadlineAt.toISOString(),
      allowedRemedies: ["refund", "replacement"],
    };
    await client.query(
      `insert into product_order_customer_decisions (
         order_id, case_id, kind, scope_key, proposed_conditions,
         proposed_conditions_hash, allowed_outcomes, selected_outcome,
         token_hash, status, expires_at, exchanged_at, selected_at
       ) values (
         $1, $2, 'loss_damage_remedy', $3, $4::jsonb, $5,
         '["refund","replacement"]'::jsonb, 'replacement', $6,
         'selected', $7, now(), now()
       )`,
      [
        current.id,
        caseId,
        scopeKey,
        JSON.stringify(proposedConditions),
        hashDecisionConditions(scopeKey, proposedConditions),
        createHash("sha256").update(randomBytes(32)).digest("hex"),
        remedyDeadlineAt,
      ],
    );
    return {
      caseId,
      lines: current.line_items,
      orderDatabaseId: current.id,
      orderReference,
      sourceShipmentId: current.active_fulfillment_shipment_id,
    };
  } finally {
    await client.end();
  }
}

async function loadPreparedReplacement(caseId: string): Promise<{
  remedyShipmentId: string;
  remedyStateVersion: number;
  sourceStateVersion: number;
  totalWeightGrams: number;
}> {
  const client = await connectTestDatabase();
  try {
    const result = await client.query<{
      remedy_shipment_id: string;
      remedy_state_version: number;
      source_state_version: number;
      total_weight_grams: number;
    }>(
      `select cases.remedy_shipment_id,
              source.state_version as source_state_version,
              remedy.state_version as remedy_state_version,
              (remedy.package_snapshot->>'totalWeightGrams')::int
                as total_weight_grams
       from product_shipping_cases cases
       join product_shipments source on source.id = cases.source_shipment_id
       join product_shipments remedy on remedy.id = cases.remedy_shipment_id
       where cases.id = $1 and cases.status = 'remedy_pending'
         and remedy.status = 'ready_for_staff'`,
      [caseId],
    );
    expect(result.rows).toHaveLength(1);
    return {
      remedyShipmentId: result.rows[0]!.remedy_shipment_id,
      remedyStateVersion: result.rows[0]!.remedy_state_version,
      sourceStateVersion: result.rows[0]!.source_state_version,
      totalWeightGrams: result.rows[0]!.total_weight_grams,
    };
  } finally {
    await client.end();
  }
}

async function loadShipmentVersion(shipmentId: string): Promise<{
  stateVersion: number;
  status: string;
}> {
  const client = await connectTestDatabase();
  try {
    const result = await client.query<{
      state_version: number;
      status: string;
    }>(`select state_version, status from product_shipments where id = $1`, [
      shipmentId,
    ]);
    expect(result.rows).toHaveLength(1);
    return {
      stateVersion: result.rows[0]!.state_version,
      status: result.rows[0]!.status,
    };
  } finally {
    await client.end();
  }
}

async function expectReplacementAdopted(
  fixture: {
    caseId: string;
    orderDatabaseId: string;
    sourceShipmentId: string;
  },
  remedyShipmentId: string,
): Promise<void> {
  const client = await connectTestDatabase();
  try {
    const result = await client.query<{
      active_fulfillment_shipment_id: string;
      remedy_shipment_id: string;
      source_shipment_id: string;
      status: string;
    }>(
      `select orders.active_fulfillment_shipment_id,
              cases.source_shipment_id, cases.remedy_shipment_id,
              remedy.status
       from checkout_orders orders
       join product_shipping_cases cases on cases.order_id = orders.id
       join product_shipments remedy on remedy.id = cases.remedy_shipment_id
       where orders.id = $1 and cases.id = $2`,
      [fixture.orderDatabaseId, fixture.caseId],
    );
    expect(result.rows).toEqual([
      {
        active_fulfillment_shipment_id: remedyShipmentId,
        remedy_shipment_id: remedyShipmentId,
        source_shipment_id: fixture.sourceShipmentId,
        status: "label_ready",
      },
    ]);
  } finally {
    await client.end();
  }
}

async function seedInventoryUnavailableReplacementCase(
  orderReference: string,
): Promise<{
  caseId: string;
  orderDatabaseId: string;
  sourceShipmentId: string;
}> {
  const client = await connectTestDatabase();
  try {
    const order = await client.query<{
      active_fulfillment_shipment_id: string;
      id: string;
    }>(
      `select id, active_fulfillment_shipment_id
       from checkout_orders
       where order_id = $1
         and status = 'paid'
         and active_fulfillment_shipment_id is not null
       limit 1`,
      [orderReference],
    );
    expect(order.rows).toHaveLength(1);
    const current = order.rows[0]!;
    await client.query(
      `update product_shipping_cases
       set status = 'resolved', resolved_at = now(), state_version = state_version + 1
       where order_id = $1
         and shipment_id = $2
         and type = 'loss'
         and status in ('open', 'waiting_customer', 'waiting_provider', 'remedy_pending')`,
      [current.id, current.active_fulfillment_shipment_id],
    );
    const inserted = await client.query<{ id: string }>(
      `insert into product_shipping_cases (
         order_id, shipment_id, source_shipment_id, type, status,
         cause, customer_update_due_at, remedy_deadline_at
       ) values (
         $1, $2, $2, 'loss', 'waiting_customer',
         'Customer selected replacement; inventory verification failed.',
         now() + interval '2 hours', now() + interval '2 days'
       ) returning id`,
      [current.id, current.active_fulfillment_shipment_id],
    );
    return {
      caseId: inserted.rows[0]!.id,
      orderDatabaseId: current.id,
      sourceShipmentId: current.active_fulfillment_shipment_id,
    };
  } finally {
    await client.end();
  }
}

async function expectInventoryFallbackRefund(
  fixture: { caseId: string; orderDatabaseId: string },
  operationIds: string[],
): Promise<void> {
  const client = await connectTestDatabase();
  try {
    const shippingCase = await client.query<{
      remedy_choice: string;
      state_version: number;
      status: string;
    }>(
      `select remedy_choice, state_version, status
       from product_shipping_cases where id = $1`,
      [fixture.caseId],
    );
    expect(shippingCase.rows).toEqual([
      expect.objectContaining({
        remedy_choice: "refund_inventory_unavailable",
        state_version: 2,
        status: "remedy_pending",
      }),
    ]);
    const allocations = await client.query<{
      adjustment_component: string;
      adjustment_direction: string;
      adjustment_status: string;
      amount_cents: number;
      automated: boolean;
      case_id: string;
      id: string;
      refund_status: string;
    }>(
      `select refunds.id, refunds.case_id, refunds.amount_cents,
              refunds.automated, refunds.status as refund_status,
              adjustments.direction as adjustment_direction,
              adjustments.component as adjustment_component,
              adjustments.status as adjustment_status
       from product_order_refunds refunds
       join product_order_adjustments adjustments
         on adjustments.id = refunds.adjustment_id
       where refunds.id = any($1::uuid[])
         and refunds.order_id = $2
       order by refunds.id`,
      [operationIds, fixture.orderDatabaseId],
    );
    expect(allocations.rows).toHaveLength(operationIds.length);
    expect(new Set(allocations.rows.map((row) => row.id))).toEqual(
      new Set(operationIds),
    );
    for (const allocation of allocations.rows) {
      expect(allocation).toMatchObject({
        adjustment_direction: "refund",
        adjustment_status: "reserved",
        automated: true,
        case_id: fixture.caseId,
        refund_status: "queued",
      });
      expect(["merchandise", "tax", "outbound_shipping"]).toContain(
        allocation.adjustment_component,
      );
      expect(allocation.amount_cents).toBeGreaterThan(0);
    }
    const capture = await client.query<{ captured: number; reserved: number }>(
      `select
         (select coalesce(sum(transactions.amount_cents), 0)::int
          from order_payment_transactions transactions
          join order_payment_obligations obligations
            on obligations.id = transactions.obligation_id
          where obligations.order_id = $1) as captured,
         (select coalesce(sum(amount_cents), 0)::int
          from product_order_refunds
          where case_id = $2) as reserved`,
      [fixture.orderDatabaseId, fixture.caseId],
    );
    expect(capture.rows[0]!.reserved).toBe(capture.rows[0]!.captured);
  } finally {
    await client.end();
  }
}

async function seedAdminCaseConflict(orderReference: string): Promise<{
  caseId: string;
  orderReference: string;
}> {
  const client = await connectTestDatabase();
  try {
    const order = await client.query<{ id: string; order_id: string }>(
      `select id, order_id
       from checkout_orders
       where order_id = $1
         and status = 'paid'
       limit 1`,
      [orderReference],
    );
    expect(order.rows).toHaveLength(1);
    await client.query(
      `update product_shipping_cases
       set status = 'resolved', resolved_at = now(), state_version = state_version + 1
       where order_id = $1 and shipment_id is null and type = 'delay'
         and status in ('open', 'waiting_customer', 'waiting_provider', 'remedy_pending')`,
      [order.rows[0]!.id],
    );
    const inserted = await client.query<{ id: string }>(
      `insert into product_shipping_cases (
         order_id, type, status, cause, customer_update_due_at
       ) values ($1, 'delay', 'open', 'Deterministic admin CAS fixture',
                 now() + interval '1 day')
       returning id`,
      [order.rows[0]!.id],
    );
    return {
      caseId: inserted.rows[0]!.id,
      orderReference: order.rows[0]!.order_id,
    };
  } finally {
    await client.end();
  }
}

async function advanceAdminCaseVersion(caseId: string): Promise<void> {
  const client = await connectTestDatabase();
  try {
    await client.query(
      `update product_shipping_cases
       set state_version = state_version + 1, updated_at = now()
       where id = $1`,
      [caseId],
    );
  } finally {
    await client.end();
  }
}

async function expectAdminCaseConflictPreserved(caseId: string): Promise<void> {
  const client = await connectTestDatabase();
  try {
    const result = await client.query<{
      state_version: number;
      status: string;
    }>(
      `select state_version, status from product_shipping_cases where id = $1`,
      [caseId],
    );
    expect(result.rows).toEqual([{ state_version: 2, status: "open" }]);
  } finally {
    await client.end();
  }
}

async function loadUnitedStatesShipment(): Promise<{
  orderReference: string;
  providerShipmentId: string;
  shipmentId: string;
  stateVersion: number;
}> {
  const client = await connectTestDatabase();
  try {
    const result = await client.query<{
      order_reference: string;
      provider_shipment_id: string;
      shipment_id: string;
      state_version: number;
    }>(
      `select orders.order_id as order_reference,
              shipments.id as shipment_id,
              shipments.provider_shipment_id,
              shipments.state_version
       from checkout_orders orders
       join product_shipments shipments
         on shipments.id = orders.active_fulfillment_shipment_id
       where orders.customer_email = 'enabled-us@example.invalid'
         and orders.status = 'paid'
         and orders.payment_risk_status = 'cleared'
         and shipments.status = 'ready_for_staff'
       order by orders.created_at desc
       limit 1`,
    );
    expect(result.rows).toHaveLength(1);
    return {
      orderReference: result.rows[0]!.order_reference,
      providerShipmentId: result.rows[0]!.provider_shipment_id,
      shipmentId: result.rows[0]!.shipment_id,
      stateVersion: result.rows[0]!.state_version,
    };
  } finally {
    await client.end();
  }
}

async function forceShipmentPollDue(shipmentId: string): Promise<void> {
  const client = await connectTestDatabase();
  try {
    await client.query(
      `update product_shipments
       set last_polled_at = now() - interval '8 hours'
       where id = $1`,
      [shipmentId],
    );
  } finally {
    await client.end();
  }
}

async function advanceShipmentTrackingTo(
  request: APIRequestContext,
  shipmentId: string,
  expectedStatus: "exception" | "in_transit" | "delivered",
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await loadShipmentStatus(shipmentId);
    if (current === expectedStatus) {
      await expectShipmentStatus(shipmentId, expectedStatus);
      return;
    }
    await forceShipmentPollDue(shipmentId);
    await runCommerceWorker(request);
  }
  await expectShipmentStatus(shipmentId, expectedStatus);
}

async function loadShipmentStatus(shipmentId: string): Promise<string> {
  const client = await connectTestDatabase();
  try {
    const result = await client.query<{ status: string }>(
      `select status from product_shipments where id = $1`,
      [shipmentId],
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0]!.status;
  } finally {
    await client.end();
  }
}

async function expectShipmentStatus(
  shipmentId: string,
  status: string,
): Promise<void> {
  const client = await connectTestDatabase();
  try {
    const result = await client.query<{
      actual_purchase_total_cents: number | null;
      status: string;
      tracking_number: string | null;
    }>(
      `select status, actual_purchase_total_cents, tracking_number
       from product_shipments where id = $1`,
      [shipmentId],
    );
    expect(result.rows).toEqual([
      expect.objectContaining({
        actual_purchase_total_cents: 1_200,
        status,
      }),
    ]);
    expect(result.rows[0]!.tracking_number).toMatch(/^E2ETRACK/);
  } finally {
    await client.end();
  }
}

async function expectShipmentEmailCompleted(
  shipmentId: string,
  kind: "exception" | "delivered",
): Promise<void> {
  const client = await connectTestDatabase();
  try {
    const result = await client.query<{
      delivered_email_sent_at: Date | null;
      exception_email_sent_at: Date | null;
      outbox_status: string;
    }>(
      `select shipments.delivered_email_sent_at,
              shipments.exception_email_sent_at,
              outbox.status as outbox_status
       from product_shipments shipments
       join customer_email_outbox outbox
         on outbox.provider_idempotency_key = $2
       where shipments.id = $1`,
      [shipmentId, `product-shipment-${kind}:${shipmentId}`],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.outbox_status).toBe("sent");
    expect(
      kind === "exception"
        ? result.rows[0]!.exception_email_sent_at
        : result.rows[0]!.delivered_email_sent_at,
    ).toBeTruthy();
  } finally {
    await client.end();
  }
}

async function expectProviderReturnRecorded(fixture: {
  providerShipmentId: string;
  shipmentId: string;
}): Promise<void> {
  const client = await connectTestDatabase();
  try {
    const result = await client.query<{
      case_type: string;
      match_status: string;
      provider_return_id: string;
      return_reason: string;
    }>(
      `select observations.provider_return_id,
              observations.match_status,
              observations.return_reason,
              cases.type as case_type
       from product_shipment_return_observations observations
       join product_shipping_cases cases on cases.id = observations.case_id
       where observations.provider_shipment_id = $1
         and observations.shipment_id = $2`,
      [fixture.providerShipmentId, fixture.shipmentId],
    );
    expect(result.rows).toEqual([
      expect.objectContaining({
        case_type: "unclaimed",
        match_status: "matched",
        provider_return_id: `e2e-return-${fixture.providerShipmentId}`,
        return_reason: "unclaimed",
      }),
    ]);
  } finally {
    await client.end();
  }
}

async function seedManualShippingOfferForPickupRace(
  orderReference: string,
): Promise<{
  bearerToken: string;
  checkoutToken: string;
  decisionId: string;
  obligationId: string;
  orderDatabaseId: string;
  orderReference: string;
  scopeKey: string;
}> {
  const client = await connectTestDatabase();
  try {
    const order = await client.query<{
      id: string;
      order_id: string;
      disclosure_snapshot: Record<string, unknown>;
      policy_version: string;
      tax_policy_version: string;
    }>(
      `select o.id, o.order_id, primary_obligation.disclosure_snapshot,
              primary_obligation.policy_version,
              primary_obligation.tax_policy_version
       from checkout_orders o
       join order_payment_obligations primary_obligation
         on primary_obligation.order_id = o.id
        and primary_obligation.purpose = 'primary'
       where o.order_id = $1
         and o.status = 'paid'
         and o.fulfillment_mode = 'manual_pickup'
       limit 1`,
      [orderReference],
    );
    expect(order.rows).toHaveLength(1);
    const current = order.rows[0]!;
    const sequence = 1_000_000 + randomBytes(3).readUIntBE(0, 3);
    const amountCents = 1000;
    const checkoutToken = `e2e_checkout_${sequence}_${amountCents}`;
    const secretToken = `e2e_secret_${sequence}_${amountCents}_0123456789abcdef`;
    const checkoutKey = Buffer.from(
      "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
      "base64",
    );
    const expiresAt = new Date(Date.now() + 60 * 60_000);
    const obligation = await client.query<{ id: string }>(
      `insert into order_payment_obligations (
         order_id, purpose, status, merchandise_amount_cents,
         shipping_amount_cents, tax_amount_cents, total_amount_cents,
         currency, provider_invoice_id, provider_invoice_number,
         provider_checkout_id, checkout_token_hash, secret_token_ciphertext,
         initialization_status, initialization_outcome, source_workflow,
         disclosure_snapshot, tax_policy_version, policy_version, expires_at,
         idempotency_key
       ) values (
         $1, 'manual_shipping', 'pending', 0, $2, 0, $2, 'CAD', $3, $4,
         $5, $6, $7, 'ready', 'succeeded', 'commerce_e2e_pickup_race',
         $8::jsonb, $9, $10, $11, $12
       ) returning id`,
      [
        current.id,
        amountCents,
        800000 + sequence,
        `E2E-INV-${sequence}`,
        checkoutToken,
        createHmac("sha256", checkoutKey)
          .update(checkoutToken, "utf8")
          .digest("hex"),
        encryptCheckoutSecretForFixture(secretToken, checkoutKey),
        JSON.stringify(current.disclosure_snapshot),
        current.tax_policy_version,
        current.policy_version,
        expiresAt,
        `commerce-e2e/manual-shipping/${current.id}/${randomBytes(8).toString("hex")}`,
      ],
    );
    const obligationId = obligation.rows[0]!.id;
    const scopeKey = `supplemental-payment/${obligationId}`;
    const disclosureSnapshot = {
      agreement:
        "Customer accepted the separately agreed manual shipping amount.",
      fixtureVersion: "commerce-e2e-manual-shipping-v1",
    };
    await client.query(
      `update order_payment_obligations
       set disclosure_snapshot = disclosure_snapshot || $2::jsonb
       where id = $1`,
      [obligationId, JSON.stringify({ supplemental: disclosureSnapshot })],
    );
    const mergedDisclosure = {
      ...current.disclosure_snapshot,
      supplemental: disclosureSnapshot,
    };
    const proposedConditions = {
      obligationId,
      purpose: "manual_shipping",
      amountCents,
      currency: "CAD",
      expiresAt: expiresAt.toISOString(),
      policyVersion: current.policy_version,
      taxPolicyVersion: current.tax_policy_version,
      disclosureSnapshot: mergedDisclosure,
      disclosureHash: hashDecisionConditions(
        "supplemental-payment-disclosure/v1",
        mergedDisclosure,
      ),
    };
    const bearerToken = randomBytes(32).toString("base64url");
    const decision = await client.query<{ id: string }>(
      `insert into product_order_customer_decisions (
         order_id, kind, scope_key, scope_version, proposed_conditions,
         proposed_conditions_hash, allowed_outcomes, token_hash, status,
         expires_at
       ) values (
         $1, 'supplemental_payment', $2, 1, $3::jsonb, $4,
         '["pay"]'::jsonb, $5, 'pending', $6
       ) returning id`,
      [
        current.id,
        scopeKey,
        JSON.stringify(proposedConditions),
        hashDecisionConditions(scopeKey, proposedConditions),
        createHmac("sha256", "e2e-shipping-decision-secret-0123456789-ABCDEFGH")
          .update(bearerToken)
          .digest("hex"),
        expiresAt,
      ],
    );
    return {
      bearerToken,
      checkoutToken,
      decisionId: decision.rows[0]!.id,
      obligationId,
      orderDatabaseId: current.id,
      orderReference: current.order_id,
      scopeKey,
    };
  } finally {
    await client.end();
  }
}

async function expectDecisionNotExchanged(decisionId: string): Promise<void> {
  const client = await connectTestDatabase();
  try {
    const result = await client.query<{ exchanged_at: Date | null }>(
      `select exchanged_at from product_order_customer_decisions where id = $1`,
      [decisionId],
    );
    expect(result.rows).toEqual([{ exchanged_at: null }]);
  } finally {
    await client.end();
  }
}

async function markPickupRaceWinner(
  orderDatabaseId: string,
  obligationId: string,
): Promise<void> {
  const client = await connectTestDatabase();
  try {
    await client.query("begin");
    await client.query(
      `update checkout_orders
       set manual_fulfillment_status = 'dispatched', updated_at = now()
       where id = $1 and fulfillment_mode = 'manual_pickup' and status = 'paid'`,
      [orderDatabaseId],
    );
    await client.query(
      `update order_payment_obligations
       set status = 'cancelled', updated_at = now()
       where id = $1 and status = 'pending'`,
      [obligationId],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

async function expectLateSupplementalCaptureReserved(input: {
  decisionId: string;
  obligationId: string;
  orderDatabaseId: string;
}): Promise<void> {
  const client = await connectTestDatabase();
  try {
    const result = await client.query<{
      decision_status: string;
      fulfillment_mode: string;
      manual_fulfillment_status: string;
      obligation_status: string;
      payment_risk_status: string;
      refund_cents: number;
      refund_count: number;
      transaction_count: number;
    }>(
      `select o.fulfillment_mode, o.manual_fulfillment_status,
              o.payment_risk_status, obligation.status as obligation_status,
              decision.status as decision_status,
              count(distinct transaction.id)::int as transaction_count,
              count(distinct refund.id)::int as refund_count,
              coalesce(sum(distinct refund.amount_cents), 0)::int as refund_cents
       from checkout_orders o
       join order_payment_obligations obligation on obligation.id = $2
       join product_order_customer_decisions decision on decision.id = $3
       left join order_payment_transactions transaction
         on transaction.obligation_id = obligation.id
       left join product_order_refunds refund
         on refund.payment_transaction_id = transaction.id
       where o.id = $1
       group by o.id, obligation.id, decision.id`,
      [input.orderDatabaseId, input.obligationId, input.decisionId],
    );
    expect(result.rows).toEqual([
      {
        decision_status: "pending",
        fulfillment_mode: "manual_pickup",
        manual_fulfillment_status: "dispatched",
        obligation_status: "cancelled",
        payment_risk_status: "review_required",
        refund_cents: 1000,
        refund_count: 1,
        transaction_count: 1,
      },
    ]);
  } finally {
    await client.end();
  }
}

async function connectTestDatabase(): Promise<Client> {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TEST_DATABASE_URL is required");
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

function encryptCheckoutSecretForFixture(secret: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

function hashDecisionConditions(
  scopeKey: string,
  proposedConditions: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(`${scopeKey}\n${stableJson(proposedConditions)}`)
    .digest("hex");
}

function stableJson(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return JSON.stringify(value ?? null);
  }
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, JSON.parse(stableJson(nested))]),
    ),
  );
}

function readSetCookieValue(
  header: string | undefined,
  name: string,
): string | null {
  if (!header) return null;
  const marker = `${name}=`;
  const start = header.indexOf(marker);
  if (start < 0) return null;
  const valueStart = start + marker.length;
  const end = header.indexOf(";", valueStart);
  return header.slice(valueStart, end < 0 ? undefined : end) || null;
}
