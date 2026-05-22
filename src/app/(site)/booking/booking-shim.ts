import type { BookingType } from "@/lib/booking/types";
import {
  type IssuedTrainingSchedulingTokenRecord,
  type PendingTrainingEnrollmentRecord,
} from "@/lib/commerce/training-enrollment-store";
import {
  buildServiceBookingUrl,
  buildTrainingScheduleUrl,
} from "@/lib/training-checkout";
import type { TBookingOffering } from "@/types";

export type BookingShimSearchParams = Record<string, string | string[] | undefined>;

export interface BookingShimDependencies {
  findPendingTrainingEnrollmentByToken(input: { schedulingToken: string }): Promise<PendingTrainingEnrollmentRecord | null>;
  getBookingOfferingBySlug(slug: string): Promise<TBookingOffering | null>;
  getPaidPendingTrainingEnrollmentConfirmationByPublicOrderId(orderId: string): Promise<PendingTrainingEnrollmentRecord | null>;
  issueTrainingSchedulingTokenForPaidOrderIfMissing(orderId: string): Promise<IssuedTrainingSchedulingTokenRecord | null>;
}

export type BookingShimResolution =
  | { kind: "notFound" }
  | { kind: "redirect"; href: string; redirectMode: "permanent" | "temporary" }
  | { initialBookingType?: BookingType; initialOfferingSlug?: string; kind: "render" };

type ExclusiveAliasGroupResult =
  | { kind: "absent" }
  | { kind: "present"; value: string }
  | { kind: "conflict" };

const LEGACY_QUERY_KEYS = new Set([
  "type",
  "order",
  "offering",
  "offeringSlug",
  "token",
  "schedulingToken",
  "paidSchedulingToken",
  "email",
  "phone",
  "name",
  "next",
  "returnUrl",
]);

const PII_AND_EXTERNAL_QUERY_KEYS = new Set([
  "email",
  "phone",
  "name",
  "next",
  "returnUrl",
]);

const TRAINING_TYPES = new Set<BookingType>(["training-call", "in-person-appointment"]);

export async function resolveBookingShim(
  searchParams: BookingShimSearchParams,
  dependencies: BookingShimDependencies,
): Promise<BookingShimResolution> {
  const parsed = parseSearchParams(searchParams);

  if (!parsed || parsed.size === 0) {
    return { kind: "notFound" };
  }

  for (const key of parsed.keys()) {
    if (!LEGACY_QUERY_KEYS.has(key)) {
      return { kind: "notFound" };
    }
  }

  for (const key of PII_AND_EXTERNAL_QUERY_KEYS) {
    if (parsed.has(key)) {
      return { kind: "notFound" };
    }
  }

  const serviceSlug = getExclusiveString(parsed, ["offeringSlug", "offering"]);
  const orderId = getExclusiveString(parsed, ["order"]);
  const bookingType = getExclusiveString(parsed, ["type"]);
  const schedulingToken = getExclusiveString(parsed, ["schedulingToken", "token", "paidSchedulingToken"]);

  if (serviceSlug.kind === "conflict" || schedulingToken.kind === "conflict" || bookingType.kind === "conflict") {
    return { kind: "notFound" };
  }

  if (serviceSlug.kind === "present") {
    if (orderId.kind === "present" || bookingType.kind === "present" || schedulingToken.kind === "present") {
      return { kind: "notFound" };
    }

    const offering = await dependencies.getBookingOfferingBySlug(serviceSlug.value);

    if (!offering) {
      return { kind: "notFound" };
    }

    return {
      kind: "redirect",
      href: buildServiceBookingUrl({ serviceSlug: offering.slug }),
      redirectMode: "permanent",
    };
  }

  if (orderId.kind === "present") {
    if (bookingType.kind !== "present" || bookingType.value !== "training-call") {
      return { kind: "notFound" };
    }

    if (schedulingToken.kind === "present") {
      const enrollment = await dependencies.findPendingTrainingEnrollmentByToken({ schedulingToken: schedulingToken.value });

      if (
        !enrollment ||
        enrollment.checkoutOrder.orderId !== orderId.value ||
        typeof enrollment.programSnapshot.slug !== "string" ||
        enrollment.programSnapshot.slug.trim().length === 0
      ) {
        return { kind: "notFound" };
      }

      return {
        kind: "redirect",
        href: buildTrainingScheduleUrl({
          programSlug: enrollment.programSnapshot.slug,
          schedulingToken: schedulingToken.value,
        }),
        redirectMode: "temporary",
      };
    }

    const issued = await dependencies.issueTrainingSchedulingTokenForPaidOrderIfMissing(orderId.value);

    if (
      !issued ||
      issued.checkoutOrder.orderId !== orderId.value ||
      typeof issued.programSnapshot.slug !== "string" ||
      issued.programSnapshot.slug.trim().length === 0
    ) {
      return { kind: "notFound" };
    }

    return {
      kind: "redirect",
      href: buildTrainingScheduleUrl({
        programSlug: issued.programSnapshot.slug,
        schedulingToken: issued.schedulingToken,
      }),
      redirectMode: "temporary",
    };
  }

  if (bookingType.kind !== "present") {
    return { kind: "notFound" };
  }

  if (!TRAINING_TYPES.has(bookingType.value as BookingType)) {
    return { kind: "notFound" };
  }

  if (schedulingToken.kind === "present") {
    return { kind: "notFound" };
  }

  return {
    kind: "render",
    initialBookingType: bookingType.value === "training-call" ? "training-call" : undefined,
  };
}

function parseSearchParams(searchParams: BookingShimSearchParams): Map<string, string> | null {
  const parsed = new Map<string, string>();

  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) {
      return null;
    }

    if (value === undefined) {
      continue;
    }

    const trimmed = value.trim();

    if (trimmed.length === 0) {
      return null;
    }

    parsed.set(key, trimmed);
  }

  return parsed;
}

function getExclusiveString(params: Map<string, string>, keys: readonly string[]): ExclusiveAliasGroupResult {
  let found: string | undefined;
  let sawPresent = false;

  for (const key of keys) {
    const value = params.get(key);

    if (value === undefined) {
      continue;
    }

    if (sawPresent) {
      return { kind: "conflict" };
    }

    sawPresent = true;
    found = value;
  }

  if (!sawPresent || found === undefined) {
    return { kind: "absent" };
  }

  return { kind: "present", value: found };
}
