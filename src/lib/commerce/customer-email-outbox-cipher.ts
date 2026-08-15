import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { getCheckoutSecretEncryptionKey } from "@/sanity/env";

const VERSION = "v1";
const IV_BYTES = 12;
const AAD_PREFIX = "lash-her/customer-email-outbox";

export type CustomerEmailOutboxEncryptedField = "recipient" | "payload";

export function encryptCustomerEmailOutboxValue(
  value: unknown,
  field: CustomerEmailOutboxEncryptedField,
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(
    "aes-256-gcm",
    getCheckoutSecretEncryptionKey(),
    iv,
  );
  cipher.setAAD(Buffer.from(`${AAD_PREFIX}/${VERSION}/${field}`, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [
    VERSION,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptCustomerEmailOutboxValue(
  encrypted: string,
  field: CustomerEmailOutboxEncryptedField,
): unknown {
  const parts = encrypted.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Malformed customer email outbox ciphertext");
  }
  const [, ivValue, tagValue, ciphertextValue] = parts;
  const iv = decode(ivValue);
  const tag = decode(tagValue);
  const ciphertext = decode(ciphertextValue);
  if (iv.length !== IV_BYTES || tag.length !== 16) {
    throw new Error("Malformed customer email outbox ciphertext");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    getCheckoutSecretEncryptionKey(),
    iv,
  );
  decipher.setAAD(Buffer.from(`${AAD_PREFIX}/${VERSION}/${field}`, "utf8"));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext) as unknown;
}

function decode(value: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (!value || decoded.toString("base64") !== value) {
    throw new Error("Malformed customer email outbox ciphertext");
  }
  return decoded;
}
