import "server-only";

import { nanoid } from "nanoid";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  checkoutOrders,
  productShippingCases,
  productShipments,
  type ProductShippingCaseType,
  type ProductShipmentPurpose,
} from "@/lib/private-db/schema";
import { hashShippingQuoteToken } from "./quote-token";
import { issueShippingCustomerToken } from "./customer-token";

export async function openProductShippingCase(input: {
  orderId: string;
  shipmentId?: string;
  type: ProductShippingCaseType;
  cause?: string;
  eligibleAt?: Date;
  carrierDeadlineAt?: Date;
  customerUpdateDueAt?: Date;
  remedyDeadlineAt?: Date;
  createdByAdminUserId?: string;
}) {
  const db = getPrivateDb();
  const [existing] = await db
    .select()
    .from(productShippingCases)
    .where(
      and(
        eq(productShippingCases.orderId, input.orderId),
        eq(productShippingCases.type, input.type),
        inArray(productShippingCases.status, [
          "open",
          "waiting_customer",
          "waiting_provider",
          "remedy_pending",
        ]),
      ),
    )
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(productShippingCases)
    .values({
      ...input,
      cause: input.cause?.trim().slice(0, 500),
    })
    .returning();
  return created!;
}

export async function updateProductShippingCase(input: {
  caseId: string;
  action: "acknowledge" | "claim" | "inspect" | "resolve";
  cause?: string;
  providerClaimReference?: string;
  evidenceChecklist?: Record<string, boolean>;
  remedyChoice?: string;
}) {
  const now = new Date();
  const [current] = await getPrivateDb()
    .select({ type: productShippingCases.type })
    .from(productShippingCases)
    .where(eq(productShippingCases.id, input.caseId))
    .limit(1);
  if (!current) throw new Error("Shipping case was not found");
  if (
    input.action === "inspect" &&
    ["refused", "unclaimed", "return_to_sender"].includes(current.type) &&
    !["customer", "lash_her", "carrier"].includes(input.cause ?? "")
  )
    throw new Error(
      "Return inspection cause must be customer, lash_her, or carrier",
    );
  const [updated] = await getPrivateDb()
    .update(productShippingCases)
    .set({
      ...(input.cause ? { cause: input.cause.trim().slice(0, 500) } : {}),
      ...(input.providerClaimReference
        ? {
            providerClaimReference: input.providerClaimReference
              .trim()
              .slice(0, 200),
          }
        : {}),
      ...(input.evidenceChecklist
        ? { evidenceChecklist: input.evidenceChecklist }
        : {}),
      ...(input.remedyChoice ? { remedyChoice: input.remedyChoice } : {}),
      ...(input.action === "acknowledge" ? { acknowledgedAt: now } : {}),
      ...(input.action === "claim"
        ? { status: "waiting_provider" as const }
        : {}),
      ...(input.action === "inspect"
        ? { status: "remedy_pending" as const }
        : {}),
      ...(input.action === "resolve"
        ? { status: "resolved" as const, resolvedAt: now }
        : {}),
      updatedAt: now,
    })
    .where(eq(productShippingCases.id, input.caseId))
    .returning();
  if (!updated) throw new Error("Shipping case was not found");
  return updated;
}

export async function createShipmentGeneration(input: {
  caseId: string;
  purpose: Extract<ProductShipmentPurpose, "replacement" | "reshipment">;
  inventoryConfirmed: boolean;
}) {
  if (!input.inventoryConfirmed)
    throw new Error("Inventory must be confirmed before replacement");
  return getPrivateDb().transaction(async (tx) => {
    const [row] = await tx
      .select({ case: productShippingCases, order: checkoutOrders })
      .from(productShippingCases)
      .innerJoin(
        checkoutOrders,
        eq(productShippingCases.orderId, checkoutOrders.id),
      )
      .where(eq(productShippingCases.id, input.caseId))
      .for("update")
      .limit(1);
    if (!row || !row.order.shippingAddress)
      throw new Error("Shipping case is not eligible for replacement");
    const [original] = await tx
      .select()
      .from(productShipments)
      .where(eq(productShipments.orderId, row.order.id))
      .orderBy(desc(productShipments.sequence))
      .limit(1);
    if (!original) throw new Error("Original shipment was not found");
    const [sequence] = await tx
      .select({
        next: sql<number>`coalesce(max(${productShipments.sequence}), -1) + 1`,
      })
      .from(productShipments)
      .where(eq(productShipments.orderId, row.order.id));
    const token = issueShippingCustomerToken();
    const [created] = await tx
      .insert(productShipments)
      .values({
        orderId: row.order.id,
        sequence: Number(sequence?.next ?? original.sequence + 1),
        purpose: input.purpose,
        supersedesShipmentId: original.id,
        publicReference: `lhs-${nanoid(14)}`,
        quoteTokenHash: hashShippingQuoteToken(token),
        quoteFingerprint: `generation:${input.caseId}:${nanoid(8)}`,
        destination: {
          ...original.destination,
          ...row.order.shippingAddress,
          name: row.order.customerName,
          email: row.order.customerEmail,
        },
        packageSnapshot: original.packageSnapshot,
        customsLines: original.customsLines,
        rates: [],
        quoteExpiresAt: new Date(Date.now() + 24 * 60 * 60_000),
        status: "quote_pending",
        signatureRequired: original.signatureRequired,
        signatureRequested: original.signatureRequired,
      })
      .returning();
    await tx
      .update(productShippingCases)
      .set({
        remedyChoice: input.purpose,
        status: "remedy_pending",
        updatedAt: new Date(),
      })
      .where(eq(productShippingCases.id, input.caseId));
    return created!;
  });
}
