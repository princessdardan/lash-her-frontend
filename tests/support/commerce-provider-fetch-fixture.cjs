"use strict";

const FIXTURE_FLAG = "COMMERCE_E2E_PROVIDER_FIXTURE";
const CHITCHATS_HOST = "staging.chitchats.com";
const RESEND_HOST = "api.resend.com";
const originalFetch = globalThis.fetch;
let shipmentSequence = 0;
const shipments = new Map();

if (typeof originalFetch !== "function") {
  throw new Error("Commerce provider E2E fixture requires global fetch");
}

globalThis.fetch = async function commerceProviderFixtureFetch(input, init) {
  if (process.env[FIXTURE_FLAG] !== "1") {
    return originalFetch(input, init);
  }
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin === "https://e2e-redis.invalid" && request.method === "POST") {
    return handleRedis(request, url);
  }
  if (url.host === CHITCHATS_HOST) return handleChitChats(request, url);
  if (url.host === RESEND_HOST && request.method === "POST") {
    return json({ id: `e2e-email-${Date.now()}` });
  }
  return originalFetch(request);
};

async function handleChitChats(request, url) {
  if (
    request.method === "GET" &&
    /^\/labels\/shipments\/[^/]+\.pdf$/.test(url.pathname)
  ) {
    const bytes = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n",
      "utf8",
    );
    return new Response(bytes, {
      headers: {
        "content-length": String(bytes.byteLength),
        "content-type": "application/pdf",
      },
    });
  }
  const clientPrefix = "/api/v1/clients/commerce-e2e-client";
  if (!url.pathname.startsWith(clientPrefix)) {
    return json({ error: "Unexpected Chit Chats fixture client" }, 404);
  }
  const path = url.pathname.slice(clientPrefix.length);
  if (request.method === "POST" && path === "/shipments") {
    const body = await request.json();
    shipmentSequence += 1;
    const shipment = buildQuotedShipment({
      id: `e2e-shipment-${shipmentSequence}`,
      orderId: body.order_id,
    });
    shipments.set(shipment.id, shipment);
    return json({ shipment });
  }
  if (request.method === "GET" && path === "/shipments") {
    const query = url.searchParams.get("q");
    return json(
      [...shipments.values()].filter(
        (shipment) => !query || shipment.order_id === query,
      ),
    );
  }
  if (request.method === "GET" && path === "/returns") {
    const delivered = [...shipments.values()].filter(
      (shipment) => shipment.status === "delivered",
    );
    return json({
      returns: delivered.map((shipment) => ({
        id: `e2e-return-${shipment.id}`,
        original_shipment: { id: shipment.id },
        status: "received",
        return_reason: "unclaimed",
        resolution: "inspection_required",
        created_at: shipment.fixture_purchase_at,
        updated_at: new Date(Date.now() - 1_000).toISOString(),
      })),
    });
  }
  const shipmentMatch =
    /^\/shipments\/([^/]+)(?:\/(refresh|buy|refund))?$/.exec(path);
  if (!shipmentMatch) {
    return json(
      {
        error: `Unrecognized deterministic Chit Chats fixture request: ${request.method} ${path}`,
      },
      501,
    );
  }
  const shipmentId = decodeURIComponent(shipmentMatch[1]);
  const action = shipmentMatch[2];
  const current = shipments.get(shipmentId);
  if (!current) return json({ error: "Shipment not found" }, 404);
  if (request.method === "DELETE" && !action) {
    shipments.delete(shipmentId);
    return new Response(null, { status: 204 });
  }
  if (request.method === "GET" && !action) {
    const shipment = advanceTrackingFixture(current);
    shipments.set(shipment.id, shipment);
    return json({ shipment });
  }
  if (request.method === "PATCH" && action === "refresh") {
    const body = await request.json();
    const refreshed = {
      ...current,
      package_type: body.package_type,
      weight_unit: body.weight_unit,
      weight: body.weight,
      size_unit: body.size_unit,
      size_x: body.size_x,
      size_y: body.size_y,
      size_z: body.size_z,
      insurance_requested: body.insurance_requested,
      signature_requested: body.signature_requested,
      ship_date: body.ship_date,
      updated_at: new Date().toISOString(),
    };
    shipments.set(shipmentId, refreshed);
    return json({ shipment: refreshed });
  }
  if (request.method === "PATCH" && action === "buy") {
    const body = await request.json();
    const fixturePurchaseAt = new Date(Date.now() - 60_000).toISOString();
    const addressReplacement = String(current.order_id).startsWith("lha-");
    const purchased = {
      ...current,
      carrier: "Chit Chats",
      carrier_tracking_code: `E2ETRACK${shipmentId.replace(/\D/g, "")}`,
      insurance_fee: "1.00",
      is_insured: true,
      postage_fee: addressReplacement ? "16.00" : "10.00",
      delivery_fee: "0.00",
      tariff_fee: "0.00",
      fda_prior_notification_fee: "0.00",
      federal_tax: "0.50",
      provincial_tax: "0.50",
      postage_purchase_date: fixturePurchaseAt,
      postage_type: body.postage_type,
      purchase_amount: addressReplacement ? "18.00" : "12.00",
      postage_label_pdf_url:
        `https://staging.chitchats.com/labels/shipments/${shipmentId}.pdf?auth_token=e2e-signed-label-token`,
      status: "ready",
      tracking_url: `https://tracking.example.invalid/${shipmentId}`,
      updated_at: fixturePurchaseAt,
      fixture_purchase_at: fixturePurchaseAt,
      fixture_tracking_poll: 0,
    };
    shipments.set(shipmentId, purchased);
    return json({ shipment: purchased });
  }
  if (request.method === "PATCH" && action === "refund") {
    const refunded = {
      ...current,
      status: "voided",
      updated_at: new Date().toISOString(),
    };
    shipments.set(shipmentId, refunded);
    return json({ shipment: refunded });
  }
  return json({ error: "Unsupported Chit Chats fixture method" }, 501);
}

function advanceTrackingFixture(shipment) {
  if (!shipment.fixture_purchase_at) return shipment;
  const poll = Number(shipment.fixture_tracking_poll ?? 0);
  const stages = [
    { status: "exception", title: "Delivery exception" },
    { status: "in_transit", title: "Shipment moving again" },
    { status: "delivered", title: "Delivered" },
  ];
  const stage = stages[Math.min(poll, stages.length - 1)];
  const purchasedAt = new Date(shipment.fixture_purchase_at).getTime();
  const occurredAt = new Date(purchasedAt + 10_000 * (poll + 1)).toISOString();
  const trackingEvents = [
    ...(shipment.tracking_events ?? []),
    {
      type: stage.status,
      status: stage.status,
      title: stage.title,
      created_at: occurredAt,
    },
  ];
  return {
    ...shipment,
    status: stage.status,
    tracking_events: trackingEvents,
    updated_at: occurredAt,
    fixture_tracking_poll: poll + 1,
  };
}

async function handleRedis(request, url) {
  const body = await request.json();
  const commands = url.pathname === "/pipeline" ? body : [body];
  if (!Array.isArray(commands)) {
    return json({ error: "Invalid Redis fixture request" }, 400);
  }
  const results = commands.map((command) => {
    const operation = Array.isArray(command)
      ? String(command[0] ?? "").toLowerCase()
      : "";
    if (operation === "eval" || operation === "evalsha") return [1, 1, 0];
    if (operation === "get") return null;
    if (["set", "del", "zrem"].includes(operation)) return 1;
    return null;
  });
  if (url.pathname === "/pipeline") {
    return json(results.map((result) => ({ result })));
  }
  return json({ result: results[0] });
}

function buildQuotedShipment({ id, orderId }) {
  const paymentAmount = String(orderId).startsWith("lha-")
    ? "18.00"
    : "12.00";
  return {
    created_at: new Date().toISOString(),
    estimated_delivery_at: new Date(
      Date.now() + 5 * 24 * 60 * 60_000,
    ).toISOString(),
    id,
    order_id: orderId,
    rates: [
      buildRate(
        "chit_chats_canada_tracked",
        "Chit Chats Canada Tracked",
        paymentAmount,
      ),
      buildRate(
        "chit_chats_us_edge",
        "Chit Chats U.S. Edge",
        paymentAmount,
      ),
    ],
    status: "unpaid",
    updated_at: new Date().toISOString(),
  };
}

function buildRate(postageType, description, paymentAmount) {
  return {
    delivery_time_description: "3-5 business days",
    insurance_fee: "1.00",
    is_insured: true,
    payment_amount: paymentAmount,
    postage_carrier_type: "Chit Chats",
    postage_description: description,
    postage_type: postageType,
    signature_confirmation_description: "Signature available",
    tracking_type_description: "Full tracking included",
  };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}
