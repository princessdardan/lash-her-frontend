import assert from "node:assert/strict";
import test from "node:test";
import {
  ChitChatsApiError,
  createChitChatsClient,
  parseRetryAfterSeconds,
} from "./chitchats-client";
import type { ChitChatsConfig } from "./config";

const config: ChitChatsConfig = {
  accessToken: "access-token",
  baseUrl: "https://staging.chitchats.com/api/v1/clients/client-123",
  clientId: "client-123",
  environment: "staging",
  quoteSigningSecret: "quote-signing-secret-with-safe-length",
  trackedPostageTypes: new Set(["chit_chats_canada_tracked"]),
  usShippingEnabled: false,
};

test("creates a Chit Chats shipment using the documented client-scoped contract", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const client = createChitChatsClient(config, (async (url, init) => {
    requestUrl = String(url);
    requestInit = init;
    return Response.json(
      { shipment: { id: "shipment-1", status: "unpaid", rates: [] } },
      { status: 201 },
    );
  }) as typeof fetch);

  const shipment = await client.createShipment({
    recipient: {
      name: "Client Name",
      email: "client@example.com",
      phone: "+14165550100",
      line1: "100 Test Street",
      city: "Toronto",
      province: "ON",
      postalCode: "M5V 1A1",
      country: "Canada",
      countryCode: "CA",
    },
    packageSnapshot: {
      profileId: "profile-1",
      profileSlug: "small-mailer",
      packageType: "thick_envelope",
      lengthCm: 23,
      widthCm: 15,
      heightCm: 4,
      tareWeightGrams: 40,
      totalWeightGrams: 100,
    },
    customsLines: [
      {
        productId: "product-1",
        sku: "SKU-1",
        description: "Lash cleanser",
        quantity: 1,
        unitValueCents: 2400,
        unitWeightGrams: 60,
        countryOfOrigin: "CA",
      },
    ],
    merchandiseValueCents: 2400,
    orderReference: "lhq-reference",
    signatureRequested: false,
  });

  assert.equal(shipment.id, "shipment-1");
  assert.equal(requestUrl, `${config.baseUrl}/shipments`);
  assert.equal(requestInit?.method, "POST");
  assert.equal(
    new Headers(requestInit?.headers).get("Authorization"),
    "access-token",
  );
  const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
  assert.equal(body.order_id, "lhq-reference");
  assert.equal(body.postage_type, "unknown");
  assert.equal(body.insurance_requested, true);
  assert.equal("duties_paid_requested" in body, false);
  assert.equal("vat_reference" in body, false);
  assert.equal("branch_id" in body, false);
  assert.equal("region" in body, false);
  assert.equal("chitchats_region" in body, false);
  assert.equal("intake_location_attestation_id" in body, false);
  assert.equal(body.value, "24.00");
  assert.deepEqual(body.line_items, [
    {
      quantity: 1,
      description: "Lash cleanser",
      value_amount: "24.00",
      currency_code: "cad",
      sku_code: "SKU-1",
      origin_country: "CA",
      weight_unit: "g",
      weight: 60,
    },
  ]);
});

test("US rate discovery remains DDU and omits provider DDP fields", async () => {
  let payload: Record<string, unknown> = {};
  const usConfig = { ...config, usShippingEnabled: true };
  const client = createChitChatsClient(usConfig, (async (_url, init) => {
    payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json(
      { shipment: { id: "shipment-us", status: "unpaid", rates: [] } },
      { status: 201 },
    );
  }) as typeof fetch);
  await client.createShipment({
    recipient: {
      name: "US Client",
      email: "us@example.com",
      phone: "+12125550100",
      line1: "1 Main Street",
      city: "Buffalo",
      province: "NY",
      postalCode: "14201",
      country: "United States",
      countryCode: "US",
    },
    packageSnapshot: {
      profileId: "profile-1",
      profileSlug: "small-mailer",
      packageType: "parcel",
      lengthCm: 23,
      widthCm: 15,
      heightCm: 4,
      tareWeightGrams: 40,
      totalWeightGrams: 100,
    },
    customsLines: [
      {
        productId: "product-1",
        sku: "SKU-1",
        description: "Lash cleanser",
        quantity: 1,
        unitValueCents: 2400,
        unitWeightGrams: 60,
        countryOfOrigin: "CA",
        hsTariffCode: "3304990000",
        usRegulatoryCertification: {
          version: "sku-us-v1",
          usShippingContractVersion: "us-contract-v1",
          tariffMetadataSchemaVersion: "tariff-v1",
          fdaRequirementsVersion: "fda-v1",
          evidenceReference: "evidence/us/sku-1",
          reviewedAt: "2026-08-01T00:00:00.000Z",
          validUntil: "2027-08-01T00:00:00.000Z",
          additionalTariffApplicability: "required",
          additionalTariffDetails: {
            steel: 0,
            copper: 15,
            aluminum: 85,
          },
          fdaApplicability: "provider_assessed",
        },
      },
    ],
    merchandiseValueCents: 2400,
    orderReference: "lhq-us-reference",
    signatureRequested: false,
  });
  assert.equal(payload.postage_type, "unknown");
  assert.equal("duties_paid_requested" in payload, false);
  assert.equal("vat_reference" in payload, false);
  assert.equal("branch_id" in payload, false);
  assert.equal("region" in payload, false);
  assert.equal("chitchats_region" in payload, false);
  assert.equal("intake_location_attestation_id" in payload, false);
  const [lineItem] = payload.line_items as Array<Record<string, unknown>>;
  assert.deepEqual(lineItem.additional_tariff_details, {
    steel: 0,
    copper: 15,
    aluminum: 85,
  });
  assert.equal("fda_applicability" in lineItem, false);
});

test("omits additional tariff details unless certification marks them required", async () => {
  let payload: Record<string, unknown> = {};
  const client = createChitChatsClient(config, (async (_url, init) => {
    payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json(
      { shipment: { id: "shipment-no-tariff", status: "unpaid", rates: [] } },
      { status: 201 },
    );
  }) as typeof fetch);
  await client.createShipment({
    recipient: {
      name: "Client Name",
      email: "client@example.com",
      phone: "+14165550100",
      line1: "100 Test Street",
      city: "Toronto",
      province: "ON",
      postalCode: "M5V 1A1",
      country: "Canada",
      countryCode: "CA",
    },
    packageSnapshot: {
      profileId: "profile-1",
      profileSlug: "small-mailer",
      packageType: "parcel",
      lengthCm: 23,
      widthCm: 15,
      heightCm: 4,
      tareWeightGrams: 40,
      totalWeightGrams: 100,
    },
    customsLines: [
      {
        productId: "product-1",
        sku: "SKU-1",
        description: "Lash cleanser",
        quantity: 1,
        unitValueCents: 2400,
        unitWeightGrams: 60,
        countryOfOrigin: "CA",
        usRegulatoryCertification: {
          version: "sku-us-v1",
          usShippingContractVersion: "us-contract-v1",
          tariffMetadataSchemaVersion: "tariff-v1",
          fdaRequirementsVersion: "fda-v1",
          evidenceReference: "evidence/us/sku-1",
          reviewedAt: "2026-08-01T00:00:00.000Z",
          validUntil: "2027-08-01T00:00:00.000Z",
          additionalTariffApplicability: "not_applicable",
          additionalTariffDetails: { steel: 0, copper: 0, aluminum: 0 },
          fdaApplicability: "not_applicable",
        },
      },
    ],
    merchandiseValueCents: 2400,
    orderReference: "lhq-no-tariff-reference",
    signatureRequested: false,
  });
  const [lineItem] = payload.line_items as Array<Record<string, unknown>>;
  assert.equal("additional_tariff_details" in lineItem, false);
});

test("uses documented shipment lifecycle endpoints and response shapes", async () => {
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  const client = createChitChatsClient(config, (async (url, init) => {
    requests.push({
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (String(url).includes("?limit=")) {
      return Response.json([
        { id: "shipment-1", status: "unpaid", order_id: "lhq-reference" },
      ]);
    }
    return Response.json({ shipment: { id: "shipment-1", status: "ready" } });
  }) as typeof fetch);

  assert.equal(
    (await client.findShipments("lhq-reference"))[0]?.id,
    "shipment-1",
  );
  await client.refreshShipment("shipment-1", {
    packageType: "parcel",
    weightGrams: 200,
    lengthCm: 30,
    widthCm: 20,
    heightCm: 10,
    shipDate: "today",
    signatureRequested: false,
  });
  await client.buyShipment("shipment-1", {
    postageType: "chit_chats_canada_tracked",
  });
  await client.refundShipment("shipment-1");

  assert.deepEqual(
    requests.map(({ method, url }) => [method, url]),
    [
      ["GET", `${config.baseUrl}/shipments?limit=100&page=1&q=lhq-reference`],
      ["PATCH", `${config.baseUrl}/shipments/shipment-1/refresh`],
      ["PATCH", `${config.baseUrl}/shipments/shipment-1/buy`],
      ["PATCH", `${config.baseUrl}/shipments/shipment-1/refund`],
    ],
  );
  assert.deepEqual(requests[2]?.body, {
    postage_type: "chit_chats_canada_tracked",
  });
});

test("provider Retry-After supports seconds and HTTP dates", () => {
  const now = new Date("2026-08-15T12:00:00.000Z");
  assert.equal(parseRetryAfterSeconds("45", now), 45);
  assert.equal(
    parseRetryAfterSeconds("Sat, 15 Aug 2026 12:02:00 GMT", now),
    120,
  );
  assert.equal(parseRetryAfterSeconds("invalid", now), null);
});

test("provider errors preserve Retry-After for worker scheduling", async () => {
  const client = createChitChatsClient(
    config,
    (async () =>
      new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "90" },
      })) as typeof fetch,
  );
  await assert.rejects(
    client.getShipment("shipment-1"),
    (error: unknown) =>
      error instanceof ChitChatsApiError &&
      error.status === 429 &&
      error.retryAfterSeconds === 90,
  );
});
