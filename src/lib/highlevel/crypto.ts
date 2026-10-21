import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { required } from "./config";
import { HighLevelError } from "./contract";

function key(): Buffer {
  const value = required("HIGHLEVEL_CREDENTIAL_ENCRYPTION_KEY");
  if (!/^[a-fA-F0-9]{64}$/.test(value))
    throw new HighLevelError("invalid_highlevel_encryption_key");
  return Buffer.from(value, "hex");
}
export function encryptCredential(value: unknown, location: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(`highlevel:v1:${location}`));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}
export function decryptCredential<T>(value: string, location: string): T {
  const [version, iv, tag, payload, extra] = value.split(".");
  if (version !== "v1" || !iv || !tag || !payload || extra)
    throw new HighLevelError("invalid_credential_envelope");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAAD(Buffer.from(`highlevel:v1:${location}`));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(payload, "base64url")),
      decipher.final(),
    ]).toString("utf8"),
  ) as T;
}

export function erasedIdentityKey(email: string, location: string): string {
  return `deleted:${createHmac("sha256", key()).update(`highlevel:erasure:v1:${location}:${email.trim().toLowerCase()}`).digest("hex")}`;
}
