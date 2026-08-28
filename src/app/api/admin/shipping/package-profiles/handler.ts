import { NextResponse, type NextRequest } from "next/server";

import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import {
  requirePermission,
  requireRecentAdminAuthentication,
} from "@/lib/admin/auth";
import { createAdminStepUpTarget } from "@/lib/admin/step-up-proof";
import { assertConfiguredFulfillmentOwner } from "@/lib/shipping/configured-owner";
import {
  approvePackageProfile,
  createPackageProfileDraft,
  disablePackageProfile,
  editPackageProfileDraft,
  normalizePackageProfileFields,
  OWNER_PACKAGE_APPROVAL_ACTION,
  PackageProfileConflictError,
  PackageProfileValidationError,
  type PackageProfileFields,
} from "@/lib/shipping/package-profiles";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const EVIDENCE_REFERENCE_MIN = 6;
const EVIDENCE_REFERENCE_MAX = 500;

interface Actor {
  user: { id: string };
}

type AuditActor = Parameters<typeof recordAdminAuditBestEffort>[0]["actor"];

interface HandlerDependencies {
  audit: typeof recordAdminAuditBestEffort;
  requireConfiguredOwner: typeof assertConfiguredFulfillmentOwner;
  requireConfigMutation: () => void;
  requireManage: () => Promise<Actor>;
  requireStepUp: typeof requireRecentAdminAuthentication;
  createDraft: typeof createPackageProfileDraft;
  editDraft: typeof editPackageProfileDraft;
  disableProfile: typeof disablePackageProfile;
  approveProfile: typeof approvePackageProfile;
}

const dependencies: HandlerDependencies = {
  audit: recordAdminAuditBestEffort,
  requireConfiguredOwner: assertConfiguredFulfillmentOwner,
  // Package-profile config is guarded by owner authentication + step-up; the
  // former shipping-policy enforcement-mode gate was removed with that subsystem.
  requireConfigMutation: () => undefined,
  requireManage: () => requirePermission("fulfillment:manage"),
  requireStepUp: requireRecentAdminAuthentication,
  createDraft: createPackageProfileDraft,
  editDraft: editPackageProfileDraft,
  disableProfile: disablePackageProfile,
  approveProfile: approvePackageProfile,
};

export function createPackageProfileCreateHandler(
  overrides: Partial<HandlerDependencies> = {},
) {
  const deps = { ...dependencies, ...overrides };

  return async function handle(request: NextRequest): Promise<Response> {
    const guarded = await guard(request, deps);
    if ("response" in guarded) return guarded.response;

    const body = await parseBody(request);
    let fields: PackageProfileFields;
    try {
      fields = normalizePackageProfileFields(body);
    } catch (error) {
      return badRequest(error);
    }

    try {
      const result = await deps.createDraft({
        actorAdminUserId: guarded.actor.user.id,
        fields,
      });
      await deps.audit({
        action: "fulfillment.package_profile.create",
        actor: guarded.actor as AuditActor,
        domain: "fulfillment",
        outcome: "success",
        targetId: result.id,
        targetType: "shipping_package_profile",
        metadata: { slug: fields.slug },
      });
      return NextResponse.json(
        { id: result.id, updatedAt: result.updatedAt.toISOString() },
        { status: 201 },
      );
    } catch (error) {
      return mutationError(error);
    }
  };
}

export function createPackageProfileMutationHandler(
  overrides: Partial<HandlerDependencies> = {},
) {
  const deps = { ...dependencies, ...overrides };

  return async function handle(
    request: NextRequest,
    input: { entityId: string },
  ): Promise<Response> {
    const guarded = await guard(request, deps);
    if ("response" in guarded) return guarded.response;

    if (!UUID_PATTERN.test(input.entityId)) {
      return NextResponse.json(
        { error: "Package profile ID is invalid" },
        { status: 400 },
      );
    }

    const body = await parseBody(request);
    const action = typeof body?.action === "string" ? body.action : "";
    const expectedUpdatedAt = parseDate(body?.expectedUpdatedAt);
    if (!expectedUpdatedAt) {
      return NextResponse.json(
        { error: "A valid expectedUpdatedAt timestamp is required" },
        { status: 400 },
      );
    }

    if (action === "disable") {
      try {
        const result = await deps.disableProfile({
          actorAdminUserId: guarded.actor.user.id,
          id: input.entityId,
          expectedUpdatedAt,
        });
        await deps.audit({
          action: "fulfillment.package_profile.disable",
          actor: guarded.actor as AuditActor,
          domain: "fulfillment",
          outcome: "success",
          targetId: input.entityId,
          targetType: "shipping_package_profile",
        });
        return NextResponse.json(
          { id: result.id, updatedAt: result.updatedAt.toISOString() },
          { status: 200 },
        );
      } catch (error) {
        return mutationError(error);
      }
    }

    if (action === "edit") {
      let fields: PackageProfileFields;
      try {
        fields = normalizePackageProfileFields(body);
      } catch (error) {
        return badRequest(error);
      }
      try {
        const result = await deps.editDraft({
          actorAdminUserId: guarded.actor.user.id,
          id: input.entityId,
          expectedUpdatedAt,
          fields,
        });
        await deps.audit({
          action: "fulfillment.package_profile.edit",
          actor: guarded.actor as AuditActor,
          domain: "fulfillment",
          outcome: "success",
          targetId: input.entityId,
          targetType: "shipping_package_profile",
          metadata: { slug: fields.slug },
        });
        return NextResponse.json(
          { id: result.id, updatedAt: result.updatedAt.toISOString() },
          { status: 200 },
        );
      } catch (error) {
        return mutationError(error);
      }
    }

    if (action === "approve") {
      let fields: PackageProfileFields;
      try {
        fields = normalizePackageProfileFields(body);
      } catch (error) {
        return badRequest(error);
      }
      const evidenceReference =
        typeof body?.evidenceReference === "string"
          ? body.evidenceReference.trim()
          : "";
      if (
        evidenceReference.length < EVIDENCE_REFERENCE_MIN ||
        evidenceReference.length > EVIDENCE_REFERENCE_MAX
      ) {
        return NextResponse.json(
          {
            error: `An evidence reference between ${EVIDENCE_REFERENCE_MIN} and ${EVIDENCE_REFERENCE_MAX} characters is required`,
          },
          { status: 400 },
        );
      }

      const stepUpScope = {
        action: "shipping:package-profile:approve",
        target: createAdminStepUpTarget({
          action: OWNER_PACKAGE_APPROVAL_ACTION,
          profileId: input.entityId,
          slug: fields.slug,
          name: fields.name,
          packageType: fields.packageType,
          lengthCm: fields.lengthCm,
          widthCm: fields.widthCm,
          heightCm: fields.heightCm,
          tareWeightGrams: fields.tareWeightGrams,
          maxWeightGrams: fields.maxWeightGrams,
          acceptsRigid: fields.acceptsRigid,
          rank: fields.rank,
          evidenceReference,
          expectedUpdatedAt: expectedUpdatedAt.toISOString(),
        }),
        targetLabel: `package profile ${fields.slug}`,
      };

      try {
        const stepUpAuthenticatedAt = await deps.requireStepUp({
          ...stepUpScope,
          maxAgeMs: 4 * 60_000,
        });
        const result = await deps.approveProfile({
          actorAdminUserId: guarded.actor.user.id,
          id: input.entityId,
          expectedUpdatedAt,
          evidenceReference,
          stepUpAuthenticatedAt,
          submitted: fields,
        });
        await deps.audit({
          action: "fulfillment.package_profile.approve",
          actor: guarded.actor as AuditActor,
          domain: "fulfillment",
          outcome: "success",
          targetId: input.entityId,
          targetType: "shipping_package_profile",
          metadata: {
            slug: fields.slug,
            reviewEvidenceHash: result.reviewEvidenceHash,
          },
        });
        return NextResponse.json(
          { id: result.id, updatedAt: result.updatedAt.toISOString() },
          { status: 200 },
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Approval failed";
        if (error instanceof PackageProfileConflictError) {
          return NextResponse.json({ error: message }, { status: 409 });
        }
        // Step-up failures (missing/expired proof, or a stale-window guard)
        // return 409 with the scope so the client can re-authenticate.
        if (/step-up|authentication/i.test(message)) {
          return NextResponse.json(
            { error: message, stepUp: stepUpScope },
            { status: 409 },
          );
        }
        if (error instanceof PackageProfileValidationError) {
          return NextResponse.json({ error: message }, { status: 400 });
        }
        // Unexpected failure (e.g. DB outage): do not mask it as a benign
        // conflict — the transaction already rolled back, so rethrow into a
        // framework 500 rather than echoing a raw internal message.
        throw error;
      }
    }

    return NextResponse.json(
      { error: "Unsupported package profile action" },
      { status: 400 },
    );
  };
}

async function guard(
  request: NextRequest,
  deps: HandlerDependencies,
): Promise<{ actor: Actor } | { response: Response }> {
  const actor = await deps.requireManage();
  try {
    await deps.requireConfiguredOwner(actor.user.id);
  } catch {
    return {
      response: NextResponse.json(
        {
          error:
            "Only the configured fulfillment owner may manage shipping packages",
        },
        { status: 403 },
      ),
    };
  }
  if (request.headers.get("origin") !== request.nextUrl.origin) {
    return {
      response: NextResponse.json(
        { error: "Invalid request origin" },
        { status: 403 },
      ),
    };
  }
  try {
    deps.requireConfigMutation();
  } catch {
    return {
      response: NextResponse.json(
        { error: "Shipping package profiles are read-only in observe mode" },
        { status: 409 },
      ),
    };
  }
  return { actor };
}

async function parseBody(
  request: NextRequest,
): Promise<Record<string, unknown> | null> {
  return (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function badRequest(error: unknown): Response {
  const message = error instanceof Error ? error.message : "Invalid request";
  return NextResponse.json({ error: message }, { status: 400 });
}

function mutationError(error: unknown): Response {
  if (error instanceof PackageProfileValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof PackageProfileConflictError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  throw error;
}

export const handlePackageProfileCreate = createPackageProfileCreateHandler();
export const handlePackageProfileMutation =
  createPackageProfileMutationHandler();
