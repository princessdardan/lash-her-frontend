import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { getCheckoutSecretEncryptionKey } from "@/sanity/env";

const CHECKOUT_SECRET_VERSION = "v1";
const GCM_IV_BYTES = 12;

export function encryptCheckoutSecret(secretToken: string): string {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", getCheckoutSecretEncryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(secretToken, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    CHECKOUT_SECRET_VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptCheckoutSecret(ciphertext: string): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 4 || parts[0] !== CHECKOUT_SECRET_VERSION) {
    throw new Error("Malformed checkout secret ciphertext");
  }

  const [, ivBase64, tagBase64, ciphertextBase64] = parts;
  const iv = decodeBase64Part(ivBase64, "IV");
  const tag = decodeBase64Part(tagBase64, "auth tag");
  const encryptedSecret = decodeBase64Part(ciphertextBase64, "ciphertext");

  if (iv.length !== GCM_IV_BYTES) {
    throw new Error("Malformed checkout secret ciphertext: invalid IV length");
  }

  const decipher = createDecipheriv("aes-256-gcm", getCheckoutSecretEncryptionKey(), iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(encryptedSecret),
    decipher.final(),
  ]).toString("utf8");
}

function decodeBase64Part(value: string, label: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value) {
    throw new Error(`Malformed checkout secret ciphertext: invalid ${label}`);
  }
  return decoded;
}
