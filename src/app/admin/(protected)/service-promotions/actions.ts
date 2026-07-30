"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  createServicePromotion,
  setServicePromotionStatus,
  updateServicePromotion,
} from "@/lib/admin/service-promotions";
import { AdminAuthError } from "@/lib/admin/types";
import type { BookingConfigurationStatus } from "@/lib/private-db/schema";

const DESTINATION = "/admin/service-promotions";

export async function createServicePromotionAction(formData: FormData) {
  return runAction("Promotion code created as a draft.", () =>
    createServicePromotion(readPromotionInput(formData)),
  );
}

export async function updateServicePromotionAction(formData: FormData) {
  return runAction("Promotion code updated.", () =>
    updateServicePromotion({
      ...readPromotionInput(formData),
      promotionId: getString(formData, "promotionId"),
    }),
  );
}

export async function setServicePromotionStatusAction(formData: FormData) {
  return runAction("Promotion status updated.", () =>
    setServicePromotionStatus({
      promotionId: getString(formData, "promotionId"),
      status: getPromotionStatus(formData),
    }),
  );
}

function readPromotionInput(formData: FormData) {
  const discountType = getString(formData, "discountType");
  if (discountType !== "percentage" && discountType !== "fixed") {
    throw new Error("Invalid discount type");
  }
  const validDiscountType: "percentage" | "fixed" = discountType;

  return {
    code: getString(formData, "code"),
    discountType: validDiscountType,
    discountValue: getDiscountValue(
      getString(formData, "discountAmount"),
      validDiscountType,
    ),
    effectiveFrom: getOptionalDate(formData, "effectiveFrom"),
    effectiveUntil: getOptionalDate(formData, "effectiveUntil"),
    internalTitle: getString(formData, "internalTitle"),
    offeringIds: formData
      .getAll("offeringId")
      .filter((value): value is string => typeof value === "string"),
  };
}

async function runAction(
  success: string,
  task: () => Promise<unknown>,
): Promise<never> {
  try {
    await task();
  } catch (error) {
    redirect(feedbackUrl("error", friendlyError(error)));
  }

  revalidatePath(DESTINATION);
  redirect(feedbackUrl("notice", success));
}

function getString(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function getOptionalDate(formData: FormData, name: string): Date | null {
  const value = formData.get(name);
  if (typeof value !== "string" || value.trim().length === 0) return null;

  const date = new Date(`${value.trim()}Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} is invalid`);
  return date;
}

function getDiscountValue(
  value: string,
  discountType: "percentage" | "fixed",
): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error("Discount amount must have at most two decimals");

  const hundredths =
    Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (hundredths <= 0) throw new Error("Discount amount must be positive");
  if (discountType === "percentage" && hundredths > 10_000) {
    throw new Error("Percentage discounts cannot exceed 100%");
  }
  return hundredths;
}

function getPromotionStatus(formData: FormData): BookingConfigurationStatus {
  const status = getString(formData, "status");
  if (
    status !== "draft" &&
    status !== "active" &&
    status !== "disabled" &&
    status !== "archived"
  ) {
    throw new Error("Invalid promotion status");
  }
  return status;
}

function friendlyError(error: unknown): string {
  if (error instanceof AdminAuthError) {
    return "You do not have permission to make that change.";
  }

  if (getPostgresErrorCode(error) === "23505") {
    return "That promotion code is already in use.";
  }

  if (error instanceof Error) {
    const message = error.message.trim();
    if (
      message.length > 0 &&
      message.length <= 240 &&
      !message.includes("\n") &&
      !/(?:constraint|database|drizzle|insert into|query|relation|sql)/i.test(
        message,
      )
    ) {
      return message;
    }
  }

  return "The promotion change could not be saved.";
}

function getPostgresErrorCode(error: unknown): string | null {
  let candidate = error;
  for (let depth = 0; depth < 5 && candidate !== null; depth += 1) {
    if (typeof candidate !== "object") return null;
    if ("code" in candidate && typeof candidate.code === "string") {
      return candidate.code;
    }
    candidate = "cause" in candidate ? candidate.cause : null;
  }
  return null;
}

function feedbackUrl(kind: "error" | "notice", message: string): string {
  const query = new URLSearchParams({ [kind]: message });
  return `${DESTINATION}?${query.toString()}`;
}
