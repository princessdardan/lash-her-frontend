import {
  buildServiceBookingUrl,
} from "@/lib/training-checkout";
import type { TService } from "@/types";

export type BookingShimSearchParams = Record<string, string | string[] | undefined>;

export interface BookingShimDependencies {
  getBookableServiceBySlug(slug: string): Promise<TService | null>;
}

export type BookingShimResolution =
  | { kind: "notFound" }
  | { kind: "redirect"; href: string; redirectMode: "permanent" }
  | { kind: "render" };

type ExclusiveAliasGroupResult =
  | { kind: "absent" }
  | { kind: "present"; value: string }
  | { kind: "conflict" };

const LEGACY_QUERY_KEYS = new Set([
  "type",
  "offering",
  "offeringSlug",
  "service",
  "serviceSlug",
]);

export async function resolveBookingShim(
  searchParams: BookingShimSearchParams,
  dependencies: BookingShimDependencies,
): Promise<BookingShimResolution> {
  const parsed = parseSearchParams(searchParams);

  if (parsed === null) {
    return { kind: "notFound" };
  }

  if (parsed.size === 0) {
    return { kind: "render" };
  }

  for (const key of parsed.keys()) {
    if (!LEGACY_QUERY_KEYS.has(key)) {
      return { kind: "notFound" };
    }
  }

  const serviceSlug = getExclusiveString(parsed, ["serviceSlug", "service", "offeringSlug", "offering"]);
  const bookingType = getExclusiveString(parsed, ["type"]);

  if (serviceSlug.kind === "conflict" || bookingType.kind === "conflict") {
    return { kind: "notFound" };
  }

  if (serviceSlug.kind === "present") {
    if (bookingType.kind === "present") {
      return { kind: "notFound" };
    }

    const service = await dependencies.getBookableServiceBySlug(serviceSlug.value);

    if (!service) {
      return { kind: "notFound" };
    }

    return {
      kind: "redirect",
      href: buildServiceBookingUrl({ serviceSlug: service.slug }),
      redirectMode: "permanent",
    };
  }

  if (bookingType.kind === "absent") {
    return { kind: "notFound" };
  }

  if (bookingType.value !== "in-person-appointment") {
    return { kind: "notFound" };
  }

  return { kind: "render" };
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
