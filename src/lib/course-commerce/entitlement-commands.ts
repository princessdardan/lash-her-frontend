import { createHash } from "node:crypto";

export type CoursePaymentProvider = "helcim";

export interface GrantEntitlementCommand {
  readonly userId: string;
  readonly courseId: string;
  readonly orderId: string;
  readonly externalPaymentId?: string;
  readonly provider?: "helcim" | "square";
  readonly idempotencyKey: string;
  readonly grantReason: "purchase" | "promotion" | "import";
  readonly grantedAt: string;
  readonly expiresAt?: string | null;
}

export interface RevokeEntitlementCommand {
  readonly userId: string;
  readonly courseId: string;
  readonly orderId: string;
  readonly revokeReason: "refund" | "dispute" | "expiry";
  readonly idempotencyKey: string;
  readonly revokedAt: string;
}

export type EntitlementCommand =
  | GrantEntitlementCommand
  | RevokeEntitlementCommand;

export interface CreateGrantEntitlementCommandInput {
  courseId: string;
  courseOrderItemId: string;
  externalPaymentId?: string;
  grantedAt: Date | string;
  orderId: string;
  provider?: CoursePaymentProvider;
  userId: string;
}

export interface CreateRevokeEntitlementCommandInput {
  courseId: string;
  courseOrderItemId: string;
  orderId: string;
  revokedAt: Date | string;
  revokeReason: RevokeEntitlementCommand["revokeReason"];
  userId: string;
}

export function createGrantEntitlementCommand(
  input: CreateGrantEntitlementCommandInput,
): Readonly<GrantEntitlementCommand> {
  const command: GrantEntitlementCommand = {
    userId: requireNonEmpty(input.userId, "userId"),
    courseId: requireNonEmpty(input.courseId, "courseId"),
    orderId: requireNonEmpty(input.orderId, "orderId"),
    ...(input.externalPaymentId
      ? { externalPaymentId: input.externalPaymentId }
      : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    idempotencyKey: getGrantEntitlementIdempotencyKey(
      input.courseOrderItemId,
      input.userId,
    ),
    grantReason: "purchase",
    grantedAt: toIsoTimestamp(input.grantedAt, "grantedAt"),
    expiresAt: null,
  };

  return Object.freeze(command);
}

export function createRevokeEntitlementCommand(
  input: CreateRevokeEntitlementCommandInput,
): Readonly<RevokeEntitlementCommand> {
  const command: RevokeEntitlementCommand = {
    userId: requireNonEmpty(input.userId, "userId"),
    courseId: requireNonEmpty(input.courseId, "courseId"),
    orderId: requireNonEmpty(input.orderId, "orderId"),
    revokeReason: input.revokeReason,
    idempotencyKey: getRevokeEntitlementIdempotencyKey(
      input.courseOrderItemId,
      input.userId,
    ),
    revokedAt: toIsoTimestamp(input.revokedAt, "revokedAt"),
  };

  return Object.freeze(command);
}

export function getGrantEntitlementIdempotencyKey(
  courseOrderItemId: string,
  userId: string,
): string {
  return `course-entitlement:grant:v1:${requireNonEmpty(courseOrderItemId, "courseOrderItemId")}:${requireNonEmpty(userId, "userId")}`;
}

export function getRevokeEntitlementIdempotencyKey(
  courseOrderItemId: string,
  userId: string,
): string {
  return `course-entitlement:revoke:v1:${requireNonEmpty(courseOrderItemId, "courseOrderItemId")}:${requireNonEmpty(userId, "userId")}`;
}

export function hashEntitlementPayload(payload: EntitlementCommand): string {
  return createHash("sha256").update(stableSerialize(payload)).digest("hex");
}

export function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError("Entitlement payload contains an unsupported value");
    }
    return serialized;
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const fields = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`);

  return `{${fields.join(",")}}`;
}

function toIsoTimestamp(value: Date | string, field: string): string {
  const parsed = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`${field} must be a valid timestamp`);
  }

  return parsed.toISOString();
}

function requireNonEmpty(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must not be empty`);
  }

  return value;
}
