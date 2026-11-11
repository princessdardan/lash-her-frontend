import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

export const P2_FIRST_OWNER_PATH = "/admin/certification/first-owner";
export const P2_FIRST_OWNER_SELECTOR_PREFIX = "a3";
export const P2_FIRST_OWNER_DISCOVERY_SELECTOR_PREFIX = "a4";
export const P2_FIRST_OWNER_SELECTION_HANDOFF = "p2-first-owner-selection.json";

function validNonce(value) {
  return typeof value === "string" && /^[a-f0-9]{32}$/u.test(value) && !/^0+$/u.test(value);
}

function validNormalizedEmail(value) {
  return typeof value === "string" && value.length <= 254 &&
    value === value.normalize("NFKC").trim().toLowerCase() &&
    /^[^\s@,;<>"\\]+@[^\s@,;<>"\\]+\.[^\s@,;<>"\\]+$/u.test(value) &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

export function validP2FirstOwnerSelection(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 2 && Object.hasOwn(value, "nonce") && Object.hasOwn(value, "identitySha256") &&
    validNonce(value.nonce) &&
    typeof value.identitySha256 === "string" && /^[a-f0-9]{64}$/u.test(value.identitySha256) && !/^0+$/u.test(value.identitySha256);
}

export function validP2FirstOwnerDiscoverySelection(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 2 && Object.hasOwn(value, "nonce") && Object.hasOwn(value, "emailSha256") &&
    validNonce(value.nonce) &&
    typeof value.emailSha256 === "string" && /^[a-f0-9]{64}$/u.test(value.emailSha256) && !/^0+$/u.test(value.emailSha256);
}

export function p2FirstOwnerDiscoveryEmailSha256(nonce, normalizedEmail) {
  if (!validNonce(nonce) || !validNormalizedEmail(normalizedEmail)) return null;
  return createHash("sha256").update(JSON.stringify([
    "p2q-first-owner-discovery-email-v1", nonce, normalizedEmail,
  ])).digest("hex");
}

export function p2FirstOwnerIdentitySha256(nonce, normalizedEmail, providerUserId) {
  if (!validNonce(nonce) || !validNormalizedEmail(normalizedEmail) ||
    typeof providerUserId !== "string" || !/^[!-~]{1,255}$/u.test(providerUserId)) return null;
  return createHash("sha256").update(JSON.stringify(["p2q-first-owner-v1", nonce, normalizedEmail, providerUserId])).digest("hex");
}

export function readP2FirstOwnerSelectionHandoff(path) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 ||
      info.nlink !== 1 || info.size < 1 || info.size > 1024) return null;
    const raw = readFileSync(descriptor);
    try {
      const value = JSON.parse(raw.toString("utf8"));
      if (value === null || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).length !== 2 || value.version !== 1 || !validP2FirstOwnerSelection(value.firstOwner)) return null;
      return Object.freeze({ ...value.firstOwner });
    } finally { raw.fill(0); }
  } catch { return null; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
