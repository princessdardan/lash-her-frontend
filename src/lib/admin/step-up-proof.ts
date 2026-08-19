import "server-only";

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import { adminStepUpProofs } from "@/lib/private-db/schema";

export const ADMIN_STEP_UP_PENDING_COOKIE = "lash_admin_step_up_pending";
export const ADMIN_STEP_UP_PROOF_COOKIE = "lash_admin_step_up_proof";
export const ADMIN_STEP_UP_PROOF_TTL_MS = 5 * 60_000;
export const ADMIN_STEP_UP_CHALLENGE_TTL_MS = 2 * 60_000;

interface PendingStepUpChallenge {
  action: string;
  actorAdminUserId: string;
  issuedAt: number;
  nonce: string;
  target: string;
}

const ADMIN_STEP_UP_TARGET_PREFIX = "sha256:";
const ADMIN_STEP_UP_TARGET_MAX_BYTES = 64 * 1024;

function normalizeScope(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 240) {
    throw new Error(`Invalid step-up ${label}`);
  }
  return normalized;
}

export function createAdminStepUpTarget(scopeData: unknown): string {
  if (
    typeof scopeData === "string" &&
    /^sha256:[0-9a-f]{64}$/i.test(scopeData.trim())
  ) {
    return scopeData.trim().toLowerCase();
  }
  const canonical = stableStepUpScopeJson(scopeData);
  if (Buffer.byteLength(canonical, "utf8") > ADMIN_STEP_UP_TARGET_MAX_BYTES) {
    throw new Error("Invalid step-up target");
  }
  return `${ADMIN_STEP_UP_TARGET_PREFIX}${createHash("sha256")
    .update("lash-her/admin-step-up-target/v1\0", "utf8")
    .update(canonical, "utf8")
    .digest("hex")}`;
}

function stableStepUpScopeJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Invalid step-up target");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStepUpScopeJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${stableStepUpScopeJson(record[key])}`,
      )
      .join(",")}}`;
  }
  throw new Error("Invalid step-up target");
}

function getSigningSecret(): string {
  const secret = process.env.AUTH_SECRET?.trim();
  if (
    !secret ||
    Buffer.byteLength(secret, "utf8") < 32 ||
    new Set(secret).size < 12
  ) {
    throw new Error(
      "AUTH_SECRET must be at least 32 bytes with at least 12 distinct characters for step-up proofs",
    );
  }
  return secret;
}

function hashNonce(nonce: string): string {
  return createHash("sha256").update(nonce).digest("hex");
}

function signPayload(encodedPayload: string): string {
  return createHmac("sha256", getSigningSecret())
    .update(encodedPayload)
    .digest("base64url");
}

export function createPendingStepUpChallenge(input: {
  action: string;
  actorAdminUserId: string;
  now?: Date;
  target: string;
}): string {
  const payload: PendingStepUpChallenge = {
    action: normalizeScope(input.action, "action"),
    actorAdminUserId: normalizeScope(input.actorAdminUserId, "actor"),
    issuedAt: (input.now ?? new Date()).getTime(),
    nonce: randomBytes(24).toString("base64url"),
    target: createAdminStepUpTarget(input.target),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  );
  return `${encodedPayload}.${signPayload(encodedPayload)}`;
}

export function verifyPendingStepUpChallenge(input: {
  actorAdminUserId: string;
  now?: Date;
  token: string;
}): PendingStepUpChallenge {
  const [encodedPayload, signature, extra] = input.token.split(".");
  if (!encodedPayload || !signature || extra) {
    throw new Error("Step-up challenge is invalid");
  }
  const expected = Buffer.from(signPayload(encodedPayload));
  const received = Buffer.from(signature);
  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  ) {
    throw new Error("Step-up challenge is invalid");
  }
  let payload: PendingStepUpChallenge;
  try {
    payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as PendingStepUpChallenge;
  } catch {
    throw new Error("Step-up challenge is invalid");
  }
  const now = input.now ?? new Date();
  if (
    payload.actorAdminUserId !== input.actorAdminUserId ||
    !Number.isFinite(payload.issuedAt) ||
    payload.issuedAt > now.getTime() + 1_000 ||
    now.getTime() - payload.issuedAt > ADMIN_STEP_UP_CHALLENGE_TTL_MS
  ) {
    throw new Error(
      "Step-up challenge has expired or belongs to another actor",
    );
  }
  return {
    ...payload,
    action: normalizeScope(payload.action, "action"),
    target: createAdminStepUpTarget(payload.target),
  };
}

export function assertStepUpReauthenticationCompleted(input: {
  authenticatedAt: Date;
  challengeIssuedAt: number;
  now?: Date;
}): void {
  const now = input.now ?? new Date();
  if (
    input.authenticatedAt.getTime() + 1_000 < input.challengeIssuedAt ||
    input.authenticatedAt.getTime() > now.getTime() + 1_000 ||
    now.getTime() - input.authenticatedAt.getTime() > 60_000
  ) {
    throw new Error("Google reauthentication did not complete for this action");
  }
}

export async function issueAdminStepUpProof(input: {
  action: string;
  actorAdminUserId: string;
  authenticatedAt: Date;
  now?: Date;
  target: string;
}): Promise<{ expiresAt: Date; token: string }> {
  const now = input.now ?? new Date();
  assertStepUpReauthenticationCompleted({
    authenticatedAt: input.authenticatedAt,
    challengeIssuedAt: now.getTime() - 60_000,
    now,
  });
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(
    Math.min(
      now.getTime() + ADMIN_STEP_UP_PROOF_TTL_MS,
      input.authenticatedAt.getTime() + ADMIN_STEP_UP_PROOF_TTL_MS,
    ),
  );
  await getPrivateDb()
    .insert(adminStepUpProofs)
    .values({
      action: normalizeScope(input.action, "action"),
      actorAdminUserId: input.actorAdminUserId,
      authenticatedAt: input.authenticatedAt,
      expiresAt,
      nonceHash: hashNonce(token),
      target: createAdminStepUpTarget(input.target),
    });
  return { expiresAt, token };
}

export async function consumeAdminStepUpProof(input: {
  action: string;
  actorAdminUserId: string;
  authenticatedAt: Date;
  now?: Date;
  target: string;
  token: string;
}): Promise<Date> {
  const now = input.now ?? new Date();
  const expectedAction = normalizeScope(input.action, "action");
  const expectedTarget = createAdminStepUpTarget(input.target);
  const outcome = await getPrivateDb().transaction(async (tx) => {
    const [proof] = await tx
      .select()
      .from(adminStepUpProofs)
      .where(eq(adminStepUpProofs.nonceHash, hashNonce(input.token)))
      .for("update");
    if (!proof || proof.consumedAt) return "missing" as const;
    await tx
      .update(adminStepUpProofs)
      .set({ consumedAt: now })
      .where(
        and(
          eq(adminStepUpProofs.id, proof.id),
          isNull(adminStepUpProofs.consumedAt),
        ),
      );
    if (proof.expiresAt <= now) return "expired" as const;
    if (
      proof.actorAdminUserId !== input.actorAdminUserId ||
      proof.action !== expectedAction ||
      proof.target !== expectedTarget ||
      proof.authenticatedAt.getTime() !== input.authenticatedAt.getTime()
    ) {
      return "mismatch" as const;
    }
    return proof.authenticatedAt;
  });
  if (outcome === "missing")
    throw new Error("Step-up proof is missing or was already used");
  if (outcome === "expired") throw new Error("Step-up proof has expired");
  if (outcome === "mismatch")
    throw new Error("Step-up proof does not match this action");
  return outcome;
}
