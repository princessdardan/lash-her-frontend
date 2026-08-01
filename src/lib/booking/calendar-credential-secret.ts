import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { getBookingCalendarCredentialEncryptionKey } from "@/sanity/env";

const CIPHERTEXT_VERSION = "v1";
const GCM_IV_BYTES = 12;
const AUTHENTICATED_CONTEXT = Buffer.from(
  "lash-her:booking-calendar-credential:v1",
  "utf8",
);

export function encryptCalendarCredential(credential: string): string {
  if (credential.trim().length === 0) {
    throw new Error("Calendar credential cannot be empty");
  }

  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv(
    "aes-256-gcm",
    getBookingCalendarCredentialEncryptionKey(),
    iv,
  );
  cipher.setAAD(AUTHENTICATED_CONTEXT);
  const ciphertext = Buffer.concat([
    cipher.update(credential, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    CIPHERTEXT_VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptCalendarCredential(ciphertext: string): string {
  const parts = ciphertext.split(":");

  if (parts.length !== 4 || parts[0] !== CIPHERTEXT_VERSION) {
    throw new Error("Malformed calendar credential ciphertext");
  }

  const [, ivBase64, tagBase64, ciphertextBase64] = parts;
  const iv = decodeBase64Part(ivBase64, "IV");
  const tag = decodeBase64Part(tagBase64, "auth tag");
  const encryptedCredential = decodeBase64Part(
    ciphertextBase64,
    "ciphertext",
  );

  if (iv.length !== GCM_IV_BYTES) {
    throw new Error("Malformed calendar credential ciphertext: invalid IV length");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    getBookingCalendarCredentialEncryptionKey(),
    iv,
  );
  decipher.setAAD(AUTHENTICATED_CONTEXT);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(encryptedCredential),
    decipher.final(),
  ]).toString("utf8");
}

function decodeBase64Part(value: string, label: string): Buffer {
  const decoded = Buffer.from(value, "base64");

  if (decoded.length === 0 || decoded.toString("base64") !== value) {
    throw new Error(
      `Malformed calendar credential ciphertext: invalid ${label}`,
    );
  }

  return decoded;
}
