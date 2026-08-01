import {
  normalizeBookingMarketingOptInLabel,
  normalizeOperationalBookingQuestions,
} from "@/lib/booking/operational-ui-settings";
import {
  parsePromotionCodeInput,
  type DiscountType,
} from "@/lib/commerce/discounts";

import type { BookingQuestion } from "../types";

export interface LegacyOperationalCutoverSource {
  promotions: LegacyServicePromotionSource[];
  services: LegacyServiceCopySource[];
  settings: {
    intakeQuestions: unknown;
    marketingOptInLabel: unknown;
  } | null;
}

export interface LegacyServiceCopySource {
  _id: string;
  description?: unknown;
  shortDescription?: unknown;
  title: unknown;
}

export interface LegacyServicePromotionSource {
  _id: string;
  amount: unknown;
  appliesTo: unknown;
  code: unknown;
  discountType: unknown;
  isEnabled: unknown;
  serviceIds: unknown;
  title: unknown;
}

export interface LegacyCutoverTargetOffering {
  id: string;
  offeringKey: string;
  providerDisplayName: string;
  publicSummary: string | null;
  publicSummaryProvenance: "admin" | "legacy";
  publicTitle: string | null;
  publicTitleProvenance: "admin" | "legacy";
  serviceId: string;
  serviceDisplayTitle: string;
  serviceSanityDocumentId: string | null;
}

export interface LegacyOperationalCutoverPlan {
  counts: {
    intakeQuestionCount: number;
    offeringCopyUpdateCount: number;
    promotionCount: number;
    promotionEligibilityCount: number;
    referencedServiceCount: number;
    targetOfferingCount: number;
  };
  offeringCopyUpdates: Array<{
    offeringId: string;
    publicSummary?: string;
    publicTitle?: string;
  }>;
  promotions: Array<{
    code: string;
    discountType: DiscountType;
    discountValue: number;
    internalTitle: string;
    offeringIds: string[];
    sourceSanityDocumentId: string;
    status: "active" | "disabled";
  }>;
  settings: {
    intakeQuestions: BookingQuestion[];
    marketingOptInLabel: string;
  };
}

export interface ExistingOperationalServicePromotion {
  code: string;
  id: string;
  sourceSanityDocumentId: string | null;
}

const SANITY_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Builds the complete write plan before a transaction mutates operational data.
 * Exact Sanity service IDs are the only accepted specific-service mapping key.
 */
export function buildLegacyOperationalCutoverPlan(input: {
  offerings: LegacyCutoverTargetOffering[];
  source: LegacyOperationalCutoverSource;
}): LegacyOperationalCutoverPlan {
  if (!input.source.settings) {
    throw new Error(
      "Published Sanity booking settings were not found; operational cutover is blocked",
    );
  }

  const settings = {
    intakeQuestions: normalizeOperationalBookingQuestions(
      input.source.settings.intakeQuestions,
    ),
    marketingOptInLabel: normalizeBookingMarketingOptInLabel(
      input.source.settings.marketingOptInLabel,
    ),
  };
  const offerings = normalizeOfferings(input.offerings);
  const offeringsBySanityServiceId = indexOfferingsBySanityServiceId(offerings);
  const mappedSanityServiceIds = new Set(
    offerings.flatMap((offering) =>
      offering.serviceSanityDocumentId
        ? [offering.serviceSanityDocumentId]
        : [],
    ),
  );
  const serviceCopyById = normalizeServiceCopy(
    input.source.services,
    mappedSanityServiceIds,
  );
  const seenCodes = new Set<string>();
  const seenSourceIds = new Set<string>();
  const referencedServiceIds = new Set<string>();

  const promotions = input.source.promotions.map((source, index) => {
    const label = `Service promotion ${index + 1}`;
    const sourceSanityDocumentId = requireSanityId(source._id, `${label} ID`);
    if (seenSourceIds.has(sourceSanityDocumentId)) {
      throw new Error(
        `Duplicate Sanity service promotion document: ${sourceSanityDocumentId}`,
      );
    }
    seenSourceIds.add(sourceSanityDocumentId);

    const code = parsePromotionCodeInput(source.code);
    if (!code) throw new Error(`${label} has an invalid code`);
    if (seenCodes.has(code)) {
      throw new Error(`Duplicate Sanity service promotion code: ${code}`);
    }
    seenCodes.add(code);

    const discountType = requireDiscountType(source.discountType, label);
    const discountValue = toHundredths(
      source.amount,
      `${label} discount amount`,
    );
    if (discountType === "percentage" && discountValue > 10_000) {
      throw new Error(`${label} percentage cannot exceed 100`);
    }
    if (typeof source.isEnabled !== "boolean") {
      throw new Error(`${label} enabled state must be true or false`);
    }

    const appliesTo = source.appliesTo;
    let offeringIds: string[];
    if (appliesTo === "services") {
      if (offerings.length === 0) {
        throw new Error(
          `${label} applies to all services but no operational offerings exist`,
        );
      }
      offeringIds = offerings.map((offering) => offering.id);
    } else if (appliesTo === "specificItems") {
      const serviceIds = requireServiceIds(source.serviceIds, label);
      offeringIds = [];

      for (const serviceId of serviceIds) {
        referencedServiceIds.add(serviceId);
        const matches = offeringsBySanityServiceId.get(serviceId);
        if (!matches || matches.length === 0) {
          throw new Error(
            `${label} references Sanity service ${serviceId}, but no operational offering maps to it`,
          );
        }
        offeringIds.push(...matches.map((offering) => offering.id));
      }
    } else {
      throw new Error(
        `${label} must target all services or specific service items`,
      );
    }

    return {
      code,
      discountType,
      discountValue,
      internalTitle: requireText(source.title, `${label} title`),
      offeringIds: Array.from(new Set(offeringIds)).sort(),
      sourceSanityDocumentId,
      status: source.isEnabled ? ("active" as const) : ("disabled" as const),
    };
  });
  const offeringCopyUpdates = offerings.flatMap((offering) => {
    if (!offering.serviceSanityDocumentId) return [];
    const service = serviceCopyById.get(offering.serviceSanityDocumentId);
    if (!service) return [];
    const update = buildOfferingCopyUpdate(offering, service);
    return update ? [update] : [];
  });

  return {
    counts: {
      intakeQuestionCount: settings.intakeQuestions.length,
      offeringCopyUpdateCount: offeringCopyUpdates.length,
      promotionCount: promotions.length,
      promotionEligibilityCount: promotions.reduce(
        (count, promotion) => count + promotion.offeringIds.length,
        0,
      ),
      referencedServiceCount: referencedServiceIds.size,
      targetOfferingCount: offerings.length,
    },
    offeringCopyUpdates,
    promotions,
    settings,
  };
}

function normalizeServiceCopy(
  services: LegacyServiceCopySource[],
  mappedSanityServiceIds: Set<string>,
): Map<string, { publicSummary: string; publicTitle: string }> {
  const result = new Map<
    string,
    { publicSummary: string; publicTitle: string }
  >();

  for (const [index, service] of services.entries()) {
    const id = requireSanityId(service._id, `Sanity service ${index + 1} ID`);
    if (!mappedSanityServiceIds.has(id)) continue;
    if (result.has(id)) {
      throw new Error(`Duplicate Sanity service document: ${id}`);
    }
    const publicTitle = requireBoundedText(
      service.title,
      `Sanity service ${id} title`,
      160,
    );
    const summarySource =
      optionalText(service.shortDescription) ??
      optionalText(service.description) ??
      `Book ${publicTitle}.`;
    const publicSummary = requireBoundedText(
      summarySource,
      `Sanity service ${id} public summary`,
      500,
    );
    result.set(id, { publicSummary, publicTitle });
  }

  return result;
}

export function validateLegacyOperationalPromotionLineage(input: {
  existingPromotions: ExistingOperationalServicePromotion[];
  plan: LegacyOperationalCutoverPlan;
}): {
  existingImportedPromotionCount: number;
  stalePromotionIds: string[];
} {
  const plannedByCode = new Map(
    input.plan.promotions.map((promotion) => [promotion.code, promotion]),
  );
  const plannedBySourceId = new Map(
    input.plan.promotions.map((promotion) => [
      promotion.sourceSanityDocumentId,
      promotion,
    ]),
  );
  const existingImported = input.existingPromotions.filter(
    (promotion) => promotion.sourceSanityDocumentId !== null,
  );

  for (const existing of input.existingPromotions) {
    const plannedWithCode = plannedByCode.get(existing.code);
    const plannedWithSource = existing.sourceSanityDocumentId
      ? plannedBySourceId.get(existing.sourceSanityDocumentId)
      : undefined;

    if (plannedWithCode && !existing.sourceSanityDocumentId) {
      throw new Error(
        `Operational promotion code ${existing.code} already exists without Sanity import lineage`,
      );
    }
    if (
      plannedWithCode &&
      existing.sourceSanityDocumentId !== plannedWithCode.sourceSanityDocumentId
    ) {
      throw new Error(
        `Operational promotion code ${existing.code} belongs to a different Sanity document`,
      );
    }
    if (
      plannedWithSource &&
      existing.code !== plannedWithSource.code &&
      input.existingPromotions.some(
        (candidate) =>
          candidate.id !== existing.id &&
          candidate.code === plannedWithSource.code,
      )
    ) {
      throw new Error(
        `Sanity promotion ${plannedWithSource.sourceSanityDocumentId} cannot change to code ${plannedWithSource.code} because that code already exists`,
      );
    }
  }

  return {
    existingImportedPromotionCount: existingImported.length,
    stalePromotionIds: existingImported
      .filter(
        (promotion) =>
          !plannedBySourceId.has(promotion.sourceSanityDocumentId ?? ""),
      )
      .map((promotion) => promotion.id),
  };
}

function normalizeOfferings(
  offerings: LegacyCutoverTargetOffering[],
): LegacyCutoverTargetOffering[] {
  const byId = new Map<string, LegacyCutoverTargetOffering>();
  const serviceBySanityId = new Map<string, string>();

  for (const offering of offerings) {
    const id = requireText(offering.id, "Operational offering ID");
    const offeringKey = requireText(
      offering.offeringKey,
      `Operational offering ${id} key`,
    );
    const serviceId = requireText(
      offering.serviceId,
      `Operational offering ${offeringKey} service ID`,
    );
    const serviceSanityDocumentId =
      offering.serviceSanityDocumentId?.trim() || null;

    if (byId.has(id)) {
      throw new Error(`Duplicate operational offering ID: ${id}`);
    }
    byId.set(id, {
      id,
      offeringKey,
      providerDisplayName: requireText(
        offering.providerDisplayName,
        `Operational offering ${offeringKey} provider display name`,
      ),
      publicSummary: normalizeExistingCopy(
        offering.publicSummary,
        `Operational offering ${offeringKey} public summary`,
      ),
      publicSummaryProvenance: requireCopyProvenance(
        offering.publicSummaryProvenance,
        `Operational offering ${offeringKey} public summary provenance`,
      ),
      publicTitle: normalizeExistingCopy(
        offering.publicTitle,
        `Operational offering ${offeringKey} public title`,
      ),
      publicTitleProvenance: requireCopyProvenance(
        offering.publicTitleProvenance,
        `Operational offering ${offeringKey} public title provenance`,
      ),
      serviceId,
      serviceDisplayTitle: requireText(
        offering.serviceDisplayTitle,
        `Operational offering ${offeringKey} service display title`,
      ),
      serviceSanityDocumentId,
    });

    if (serviceSanityDocumentId) {
      const existingServiceId = serviceBySanityId.get(serviceSanityDocumentId);
      if (existingServiceId && existingServiceId !== serviceId) {
        throw new Error(
          `Sanity service ${serviceSanityDocumentId} maps to multiple operational services`,
        );
      }
      serviceBySanityId.set(serviceSanityDocumentId, serviceId);
    }
  }

  return [...byId.values()].sort((first, second) =>
    first.offeringKey.localeCompare(second.offeringKey),
  );
}

function indexOfferingsBySanityServiceId(
  offerings: LegacyCutoverTargetOffering[],
): Map<string, LegacyCutoverTargetOffering[]> {
  const result = new Map<string, LegacyCutoverTargetOffering[]>();
  for (const offering of offerings) {
    if (!offering.serviceSanityDocumentId) continue;
    const matches = result.get(offering.serviceSanityDocumentId) ?? [];
    matches.push(offering);
    result.set(offering.serviceSanityDocumentId, matches);
  }
  return result;
}

function buildOfferingCopyUpdate(
  offering: LegacyCutoverTargetOffering,
  source: { publicSummary: string; publicTitle: string },
):
  | {
      offeringId: string;
      publicSummary?: string;
      publicTitle?: string;
    }
  | undefined {
  const publicTitle = selectSafeCopyEnrichment({
    current: offering.publicTitle,
    provenance: offering.publicTitleProvenance,
    source: source.publicTitle,
  });
  const publicSummary = selectSafeCopyEnrichment({
    current: offering.publicSummary,
    provenance: offering.publicSummaryProvenance,
    source: source.publicSummary,
  });

  if (publicTitle === undefined && publicSummary === undefined)
    return undefined;
  return {
    offeringId: offering.id,
    ...(publicSummary !== undefined ? { publicSummary } : {}),
    ...(publicTitle !== undefined ? { publicTitle } : {}),
  };
}

function selectSafeCopyEnrichment(input: {
  current: string | null;
  provenance: "admin" | "legacy";
  source: string;
}): string | undefined {
  if (input.provenance === "admin") return undefined;
  return input.current === input.source ? undefined : input.source;
}

function requireCopyProvenance(
  value: unknown,
  label: string,
): "admin" | "legacy" {
  if (value !== "admin" && value !== "legacy") {
    throw new Error(`${label} must be admin or legacy`);
  }
  return value;
}

function normalizeExistingCopy(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  return value;
}

function requireServiceIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must reference at least one Sanity service`);
  }

  const ids = value.map((serviceId, index) =>
    requireSanityId(serviceId, `${label} service reference ${index + 1}`),
  );
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label} contains duplicate Sanity service references`);
  }
  return ids;
}

function requireDiscountType(value: unknown, label: string): DiscountType {
  if (value !== "percentage" && value !== "fixed") {
    throw new Error(`${label} discount type must be percentage or fixed`);
  }
  return value;
}

function toHundredths(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  const hundredths = Math.round(value * 100);
  if (Math.abs(hundredths / 100 - value) > 1e-9) {
    throw new Error(`${label} must have at most two decimal places`);
  }
  return hundredths;
}

function requireSanityId(value: unknown, label: string): string {
  const id = requireText(value, label);
  if (!SANITY_ID_PATTERN.test(id) || id.startsWith("drafts.")) {
    throw new Error(`${label} is invalid`);
  }
  return id;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function requireBoundedText(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  const text = requireText(value, label);
  if (text.length > maxLength) {
    throw new Error(`${label} must be ${maxLength} characters or fewer`);
  }
  return text;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
