import "server-only";

import {
  CUSTOMER_REPLY_TO_EMAIL,
  escapeHtml,
  sendTransactionalEmail,
} from "@/lib/transactional-email";
import type { ShipmentNotificationContext } from "./shipment-store";

export type ShipmentNotificationKind = "accepted" | "exception" | "delivered";

export interface DeliverShipmentNotificationInput {
  shipmentId: string;
  kind: ShipmentNotificationKind;
  orderReference: string;
  customerName: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  to: string;
  idempotencyKey: string;
}

export async function sendShipmentNotification(
  context: ShipmentNotificationContext,
  kind: ShipmentNotificationKind,
): Promise<{ id: string }> {
  return deliverShipmentNotification({
    shipmentId: context.shipmentId,
    kind,
    orderReference: context.orderId,
    customerName: context.customerName,
    trackingNumber: context.trackingNumber,
    trackingUrl: context.trackingUrl,
    to: context.customerEmail,
    idempotencyKey: `product-shipment-${kind}:${context.shipmentId}`,
  });
}

export async function deliverShipmentNotification(
  input: DeliverShipmentNotificationInput,
): Promise<{ id: string }> {
  const kind = input.kind;
  const copy =
    kind === "accepted"
      ? {
          subject: "Your Lash Her order is on its way",
          heading: "Your order has been accepted",
          body: "Chit Chats has received your package and tracking is now active.",
        }
      : kind === "delivered"
        ? {
            subject: "Your Lash Her order was delivered",
            heading: "Your order was delivered",
            body: "The carrier has marked your Lash Her order as delivered.",
          }
        : {
            subject: "Delivery update for your Lash Her order",
            heading: "Your delivery needs attention",
            body: "The carrier reported an exception while delivering your order. Review tracking for the latest details or reply to this email for help.",
          };
  const tracking = input.trackingUrl
    ? `<p style="margin:22px 0"><a href="${escapeHtml(input.trackingUrl)}" style="color:#5b314d;font-weight:700">View tracking${input.trackingNumber ? ` ${escapeHtml(input.trackingNumber)}` : ""}</a></p>`
    : input.trackingNumber
      ? `<p style="margin:22px 0">Tracking: ${escapeHtml(input.trackingNumber)}</p>`
      : "";
  return sendTransactionalEmail({
    to: input.to,
    replyTo: CUSTOMER_REPLY_TO_EMAIL,
    subject: copy.subject,
    idempotencyKey: input.idempotencyKey,
    tags: [
      { name: "flow", value: `product_shipment_${kind}` },
      { name: "order_id", value: input.orderReference },
    ],
    html: `<!doctype html><html lang="en"><body style="margin:0;background:#f5f1f5;color:#1c1318;font-family:Arial,sans-serif"><div style="max-width:620px;margin:36px auto;background:#fff;padding:32px;border:1px solid #e8e2e9"><h1 style="font-size:28px">${escapeHtml(copy.heading)}</h1><p>Hi ${escapeHtml(input.customerName)},</p><p style="line-height:1.7">${escapeHtml(copy.body)}</p>${tracking}<p style="color:#746a72">Order ${escapeHtml(input.orderReference)}</p></div></body></html>`,
  });
}
