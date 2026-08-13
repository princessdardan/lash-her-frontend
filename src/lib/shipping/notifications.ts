import "server-only";

import {
  CUSTOMER_REPLY_TO_EMAIL,
  escapeHtml,
  sendTransactionalEmail,
} from "@/lib/transactional-email";
import type { ShipmentNotificationContext } from "./shipment-store";

export type ShipmentNotificationKind = "accepted" | "exception" | "delivered";

export async function sendShipmentNotification(
  context: ShipmentNotificationContext,
  kind: ShipmentNotificationKind,
): Promise<void> {
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
  const tracking = context.trackingUrl
    ? `<p style="margin:22px 0"><a href="${escapeHtml(context.trackingUrl)}" style="color:#5b314d;font-weight:700">View tracking${context.trackingNumber ? ` ${escapeHtml(context.trackingNumber)}` : ""}</a></p>`
    : context.trackingNumber
      ? `<p style="margin:22px 0">Tracking: ${escapeHtml(context.trackingNumber)}</p>`
      : "";
  await sendTransactionalEmail({
    to: context.customerEmail,
    replyTo: CUSTOMER_REPLY_TO_EMAIL,
    subject: copy.subject,
    idempotencyKey: `product-shipment-${kind}:${context.shipmentId}`,
    tags: [
      { name: "flow", value: `product_shipment_${kind}` },
      { name: "order_id", value: context.orderId },
    ],
    html: `<!doctype html><html lang="en"><body style="margin:0;background:#f5f1f5;color:#1c1318;font-family:Arial,sans-serif"><div style="max-width:620px;margin:36px auto;background:#fff;padding:32px;border:1px solid #e8e2e9"><h1 style="font-size:28px">${escapeHtml(copy.heading)}</h1><p>Hi ${escapeHtml(context.customerName)},</p><p style="line-height:1.7">${escapeHtml(copy.body)}</p>${tracking}<p style="color:#746a72">Order ${escapeHtml(context.orderId)}</p></div></body></html>`,
  });
}
