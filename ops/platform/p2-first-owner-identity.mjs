import { createHash } from "node:crypto";

export const P2_FIRST_OWNER_PATH = "/admin/certification/first-owner";
export const P2_FIRST_OWNER_SELECTOR_PREFIX = "a3";

export function validP2FirstOwnerSelection(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 2 && Object.hasOwn(value, "nonce") && Object.hasOwn(value, "identitySha256") &&
    typeof value.nonce === "string" && /^[a-f0-9]{32}$/u.test(value.nonce) && !/^0+$/u.test(value.nonce) &&
    typeof value.identitySha256 === "string" && /^[a-f0-9]{64}$/u.test(value.identitySha256) && !/^0+$/u.test(value.identitySha256);
}

export function p2FirstOwnerIdentitySha256(nonce, normalizedEmail, providerUserId) {
  if (typeof nonce !== "string" || !/^[a-f0-9]{32}$/u.test(nonce) || /^0+$/u.test(nonce) ||
    typeof normalizedEmail !== "string" || normalizedEmail.length > 254 ||
    normalizedEmail !== normalizedEmail.normalize("NFKC").trim().toLowerCase() ||
    !/^[^\s@,;<>"\\]+@[^\s@,;<>"\\]+\.[^\s@,;<>"\\]+$/u.test(normalizedEmail) ||
    /[\u0000-\u001f\u007f]/u.test(normalizedEmail) ||
    typeof providerUserId !== "string" || !/^[!-~]{1,255}$/u.test(providerUserId)) return null;
  return createHash("sha256").update(JSON.stringify(["p2q-first-owner-v1", nonce, normalizedEmail, providerUserId])).digest("hex");
}
