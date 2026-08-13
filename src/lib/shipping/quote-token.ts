import "server-only";

import { createHash, createHmac, randomBytes } from "node:crypto";
import { getChitChatsConfig } from "./config";

export function issueShippingQuoteToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashShippingQuoteToken(token: string): string {
  return createHmac("sha256", getChitChatsConfig().quoteSigningSecret)
    .update(token, "utf8")
    .digest("hex");
}

export function createShippingFingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
