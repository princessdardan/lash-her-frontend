import type { AdminAuditMetadata } from "@/lib/private-db/schema";

export function sanitizeAdminAuditMetadata(
  metadata: AdminAuditMetadata | undefined,
): AdminAuditMetadata | undefined {
  if (!metadata) {
    return undefined;
  }

  return sanitizeMetadataObject(metadata);
}

function sanitizeMetadataObject(
  metadata: Record<string, unknown>,
): AdminAuditMetadata {
  const sanitized: AdminAuditMetadata = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (isSensitiveMetadataKey(key)) {
      continue;
    }

    sanitized[key] = sanitizeMetadataValue(value);
  }

  return sanitized;
}

function sanitizeMetadataValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeMetadataValue);
  }

  if (value !== null && typeof value === "object") {
    return sanitizeMetadataObject(value as Record<string, unknown>);
  }

  return value;
}

function isSensitiveMetadataKey(key: string): boolean {
  const normalized = key.toLowerCase();

  return (
    normalized.includes("authorization")
    || normalized.includes("email")
    || normalized.includes("password")
    || normalized.includes("payload")
    || normalized.includes("secret")
    || normalized.includes("token")
  );
}
