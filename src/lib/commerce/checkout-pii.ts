import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { getCheckoutPiiEncryptionKey } from "@/sanity/env";

const VERSION = "v1";
const IV_BYTES = 12;

export function encryptCheckoutIp(ipAddress: string): string {
  if (isIP(ipAddress) === 0) throw new Error("Invalid checkout IP address");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(
    "aes-256-gcm",
    getCheckoutPiiEncryptionKey(),
    iv,
  );
  const encrypted = Buffer.concat([
    cipher.update(ipAddress.toLowerCase(), "utf8"),
    cipher.final(),
  ]);
  return [
    VERSION,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

export function decryptCheckoutIp(ciphertext: string): string {
  const [version, ivValue, tagValue, encryptedValue, extra] =
    ciphertext.split(":");
  if (version !== VERSION || !ivValue || !tagValue || !encryptedValue || extra)
    throw new Error("Malformed checkout IP ciphertext");
  const iv = Buffer.from(ivValue, "base64");
  const tag = Buffer.from(tagValue, "base64");
  const encrypted = Buffer.from(encryptedValue, "base64");
  if (iv.length !== IV_BYTES || tag.length !== 16 || encrypted.length === 0)
    throw new Error("Malformed checkout IP ciphertext");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    getCheckoutPiiEncryptionKey(),
    iv,
  );
  decipher.setAuthTag(tag);
  const ipAddress = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");
  if (isIP(ipAddress) === 0) throw new Error("Invalid decrypted checkout IP");
  return ipAddress;
}
