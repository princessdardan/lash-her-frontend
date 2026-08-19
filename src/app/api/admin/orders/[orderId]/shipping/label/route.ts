import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/admin/auth";
import { createChitChatsClient } from "@/lib/shipping/chitchats-client";
import { getChitChatsConfig } from "@/lib/shipping/config";
import { getShipmentForOrderReference } from "@/lib/shipping/shipment-store";

const MAX_LABEL_BYTES = 10 * 1024 * 1024;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
): Promise<Response> {
  await requirePermission("fulfillment:manage");
  const { orderId } = await params;
  const shipmentId = req.nextUrl.searchParams.get("shipmentId")?.trim() ?? "";
  const expectedStateVersion = Number(
    req.nextUrl.searchParams.get("expectedStateVersion"),
  );
  if (
    !shipmentId ||
    !Number.isInteger(expectedStateVersion) ||
    expectedStateVersion < 1
  )
    return Response.json(
      { error: "Shipment generation and expected version are required" },
      { status: 400 },
    );
  const shipment = await getShipmentForOrderReference(orderId, {
    shipmentId,
    stateVersion: expectedStateVersion,
  });
  if (!shipment?.providerShipmentId)
    return Response.json({ error: "Shipment not found" }, { status: 404 });
  const config = getChitChatsConfig();
  let providerShipment;
  try {
    providerShipment = await createChitChatsClient(config).getShipment(
      shipment.providerShipmentId,
    );
  } catch {
    return Response.json(
      { error: "Label is temporarily unavailable" },
      { status: 502 },
    );
  }
  const signedUrl = providerShipment.postage_label_pdf_url;
  if (!signedUrl)
    return Response.json({ error: "Label is not ready" }, { status: 409 });
  let labelUrl: URL;
  try {
    labelUrl = new URL(signedUrl);
  } catch {
    return Response.json(
      { error: "Provider returned an invalid label URL" },
      { status: 502 },
    );
  }
  const apiHost = new URL(config.baseUrl).host;
  if (
    labelUrl.protocol !== "https:" ||
    Boolean(labelUrl.username) ||
    Boolean(labelUrl.password) ||
    labelUrl.host !== apiHost ||
    !/^\/labels\/shipments\//.test(labelUrl.pathname)
  ) {
    return Response.json(
      { error: "Provider returned an invalid label URL" },
      { status: 502 },
    );
  }
  let response: Response;
  try {
    response = await fetch(labelUrl, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return Response.json(
      { error: "Label could not be downloaded" },
      { status: 502 },
    );
  }
  if (!response.ok)
    return Response.json(
      { error: "Label could not be downloaded" },
      { status: 502 },
    );
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (
    contentType !== "application/pdf" ||
    (contentLength && contentLength > MAX_LABEL_BYTES)
  ) {
    return Response.json(
      { error: "Provider returned an invalid label" },
      { status: 502 },
    );
  }
  const bytes = await readBoundedBody(response, MAX_LABEL_BYTES);
  if (!bytes)
    return Response.json({ error: "Label is too large" }, { status: 502 });
  return new Response(bytes, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `inline; filename="${safeFilename(orderId)}-shipping-label.pdf"`,
      "Content-Type": "application/pdf",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<ArrayBuffer | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(result.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "order";
}
