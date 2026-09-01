import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { CONTACT_POPUP_CUSTOMER_EMAIL_MAX_LENGTH } from "@/lib/contact-popup/signup-offer-contract";
import { getCheckoutSecretEncryptionKey } from "@/sanity/env";

const LEGACY_TOKEN_VERSION = "v1";
const KEYED_TOKEN_VERSION = "v2";
const LEGACY_PAYLOAD_VERSION = 1;
const KEYED_PAYLOAD_VERSION = 2;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const SIGNATURE_BYTES = 32;
const MAX_TOKEN_LENGTH = 2_048;
const MAX_AUDIENCE_PART_LENGTH = 100;
const MAX_KEY_ID_LENGTH = 32;
const MAX_KEY_RING_ENTRIES = 32;
const MAX_KEY_RING_CONFIG_LENGTH = 4_096;
const LEGACY_TOKEN_DOMAIN = "lash-her/marketing-unsubscribe/v1";
const KEYED_TOKEN_DOMAIN = "lash-her/marketing-unsubscribe/v2";
const LEGACY_TOKEN_AAD = Buffer.from(`${LEGACY_TOKEN_DOMAIN}/payload`, "utf8");
const EMAIL_PATTERN = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

interface MarketingUnsubscribePayload {
  dataset: string;
  email: string;
  environment: string;
  issuedAt: number;
  version: 1 | 2;
}

export interface MarketingUnsubscribeTokenKeyRing {
  currentKeyId: string;
  keys: ReadonlyArray<{ id: string; rootKey: Buffer }>;
}

export interface VerifiedMarketingUnsubscribeToken {
  email: string;
  issuedAt: Date;
  tokenVersion: "v1" | "v2";
}

export interface MarketingUnsubscribeTokenCodecDependencies {
  getAudience: () => { dataset: string; environment: string };
  getKeyRing?: () => MarketingUnsubscribeTokenKeyRing | null;
  getRootKey: () => Buffer;
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
}

export interface MarketingUnsubscribeTokenCodec {
  createToken(input: { email: string; issuedAt?: Date }): string;
  verifyToken(
    token: string,
    options?: { now?: Date },
  ): VerifiedMarketingUnsubscribeToken | null;
}

const defaultCodec = createMarketingUnsubscribeTokenCodec({
  getAudience: getCurrentAudience,
  getKeyRing: () => getMarketingUnsubscribeTokenKeyRing(),
  getRootKey: getCheckoutSecretEncryptionKey,
});

export function createMarketingUnsubscribeToken(input: {
  email: string;
  issuedAt?: Date;
}): string {
  return defaultCodec.createToken(input);
}

export function verifyMarketingUnsubscribeToken(
  token: string,
  options?: { now?: Date },
): VerifiedMarketingUnsubscribeToken | null {
  return defaultCodec.verifyToken(token, options);
}

export function buildMarketingUnsubscribeUrl(input: {
  email: string;
  issuedAt?: Date;
}): string {
  const token = createMarketingUnsubscribeToken(input);
  return buildMarketingUnsubscribeUrlFromToken(token);
}

export function buildMarketingUnsubscribeUrlFromToken(token: string): string {
  const origin = getMarketingUnsubscribeSiteOrigin();
  const url = new URL("/api/marketing/unsubscribe", origin);
  url.searchParams.set("token", token);
  return url.toString();
}

export function getMarketingUnsubscribeSiteOrigin(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.NEXT_PUBLIC_SITE_URL?.trim();
  if (!configured) {
    throw new Error("Missing env var: NEXT_PUBLIC_SITE_URL");
  }

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(
      "Malformed env var: NEXT_PUBLIC_SITE_URL must be an origin",
    );
  }

  const isCanonicalOrigin =
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "";
  if (!isCanonicalOrigin) {
    throw new Error(
      "Malformed env var: NEXT_PUBLIC_SITE_URL must be an origin",
    );
  }

  const requiresHttps =
    environment.NODE_ENV === "production" ||
    environment.VERCEL_ENV === "production" ||
    environment.VERCEL_ENV === "preview";
  if (url.protocol === "https:") {
    return url.origin;
  }

  const isLocalHttpOrigin =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (!requiresHttps && isLocalHttpOrigin) {
    return url.origin;
  }

  throw new Error(
    "Malformed env var: NEXT_PUBLIC_SITE_URL must use a canonical HTTPS origin",
  );
}

export function getMarketingUnsubscribeTokenKeyRing(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): MarketingUnsubscribeTokenKeyRing | null {
  const currentKeyId = environment.MARKETING_UNSUBSCRIBE_CURRENT_KEY_ID;
  const encodedKeys = environment.MARKETING_UNSUBSCRIBE_KEYS;

  if (currentKeyId === undefined && encodedKeys === undefined) {
    // Backwards-compatible deployment path: without a dedicated ring, creation
    // and verification continue using the existing v1 checkout-derived key.
    return null;
  }
  if (currentKeyId === undefined) {
    throw new Error("Missing env var: MARKETING_UNSUBSCRIBE_CURRENT_KEY_ID");
  }
  if (encodedKeys === undefined) {
    throw new Error("Missing env var: MARKETING_UNSUBSCRIBE_KEYS");
  }
  if (!isValidKeyId(currentKeyId)) {
    throw new Error(
      "Malformed env var: MARKETING_UNSUBSCRIBE_CURRENT_KEY_ID must be a 1-32 character key ID",
    );
  }

  const entries = encodedKeys.split(",");
  if (
    encodedKeys.length > MAX_KEY_RING_CONFIG_LENGTH ||
    entries.length === 0 ||
    entries.length > MAX_KEY_RING_ENTRIES ||
    entries.some((entry) => entry.length === 0 || entry.trim() !== entry)
  ) {
    throw new Error(
      "Malformed env var: MARKETING_UNSUBSCRIBE_KEYS must contain 1-32 comma-separated key entries",
    );
  }

  const seenKeyIds = new Set<string>();
  const keys = entries.map((entry) => {
    const separatorIndex = entry.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex !== entry.lastIndexOf(":")) {
      throw new Error(
        "Malformed env var: MARKETING_UNSUBSCRIBE_KEYS entries must use key-id:base64-key",
      );
    }

    const id = entry.slice(0, separatorIndex);
    const encodedKey = entry.slice(separatorIndex + 1);
    if (!isValidKeyId(id) || seenKeyIds.has(id)) {
      throw new Error(
        "Malformed env var: MARKETING_UNSUBSCRIBE_KEYS contains an invalid or duplicate key ID",
      );
    }

    const rootKey = decodeCanonicalBase64Key(encodedKey);
    if (rootKey === null) {
      throw new Error(
        "Malformed env var: MARKETING_UNSUBSCRIBE_KEYS keys must be base64-encoded 32 bytes",
      );
    }

    seenKeyIds.add(id);
    return { id, rootKey };
  });

  if (!seenKeyIds.has(currentKeyId)) {
    throw new Error(
      "Malformed env var: MARKETING_UNSUBSCRIBE_CURRENT_KEY_ID is absent from MARKETING_UNSUBSCRIBE_KEYS",
    );
  }

  return { currentKeyId, keys };
}

export function createMarketingUnsubscribeTokenCodec(
  dependencies: MarketingUnsubscribeTokenCodecDependencies,
): MarketingUnsubscribeTokenCodec {
  const getNow = dependencies.now ?? (() => new Date());
  const generateRandomBytes = dependencies.randomBytes ?? randomBytes;

  return {
    createToken(input) {
      const email = normalizeAndValidateEmail(input.email);
      const audience = normalizeAndValidateAudience(dependencies.getAudience());
      const issuedAtDate = input.issuedAt ?? getNow();
      const issuedAt = toEpochSeconds(issuedAtDate);
      const keyRing = normalizeAndValidateKeyRing(
        dependencies.getKeyRing?.() ?? null,
      );
      const keyedRootKey = keyRing?.keys.get(keyRing.currentKeyId);
      if (keyRing !== null && keyedRootKey === undefined) {
        throw new Error(
          "Marketing unsubscribe current key ID is absent from the key ring",
        );
      }

      const isKeyedToken = keyRing !== null;
      const tokenVersion = isKeyedToken
        ? KEYED_TOKEN_VERSION
        : LEGACY_TOKEN_VERSION;
      const payloadVersion = isKeyedToken
        ? KEYED_PAYLOAD_VERSION
        : LEGACY_PAYLOAD_VERSION;
      const keyId = keyRing?.currentKeyId;
      const rootKey = keyedRootKey ?? dependencies.getRootKey();
      const tokenDomain = isKeyedToken
        ? KEYED_TOKEN_DOMAIN
        : LEGACY_TOKEN_DOMAIN;
      const tokenAad = getTokenAad(tokenVersion, keyId);
      const { encryptionKey, signingKey } = deriveTokenKeys(
        rootKey,
        tokenDomain,
      );
      const payload: MarketingUnsubscribePayload = {
        dataset: audience.dataset,
        email,
        environment: audience.environment,
        issuedAt,
        version: payloadVersion,
      };
      const iv = generateRandomBytes(IV_BYTES);
      if (iv.length !== IV_BYTES) {
        throw new Error("Marketing unsubscribe token IV has an invalid length");
      }

      const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
      cipher.setAAD(tokenAad);
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(payload), "utf8"),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();
      const signedParts = [
        tokenVersion,
        ...(keyId === undefined ? [] : [keyId]),
        encodeBase64Url(iv),
        encodeBase64Url(authTag),
        encodeBase64Url(ciphertext),
      ];
      const signedValue = signedParts.join(".");
      const signature = createHmac("sha256", signingKey)
        .update(signedValue, "utf8")
        .digest();
      const token = `${signedValue}.${encodeBase64Url(signature)}`;

      if (token.length > MAX_TOKEN_LENGTH) {
        throw new Error("Marketing unsubscribe token exceeds its size limit");
      }

      return token;
    },

    verifyToken(token, options) {
      if (
        typeof token !== "string" ||
        token.length === 0 ||
        token.length > MAX_TOKEN_LENGTH
      ) {
        return null;
      }

      const parts = token.split(".");
      const tokenVersion = parts[0];
      const isLegacyToken =
        tokenVersion === LEGACY_TOKEN_VERSION && parts.length === 5;
      const isKeyedToken =
        tokenVersion === KEYED_TOKEN_VERSION && parts.length === 6;
      if (!isLegacyToken && !isKeyedToken) {
        return null;
      }

      const keyId = isKeyedToken ? parts[1] : undefined;
      if (isKeyedToken && (keyId === undefined || !isValidKeyId(keyId))) {
        return null;
      }

      const valueOffset = isKeyedToken ? 2 : 1;
      const ivValue = parts[valueOffset];
      const authTagValue = parts[valueOffset + 1];
      const ciphertextValue = parts[valueOffset + 2];
      const signatureValue = parts[valueOffset + 3];
      const iv = decodeBase64Url(ivValue);
      const authTag = decodeBase64Url(authTagValue);
      const ciphertext = decodeBase64Url(ciphertextValue);
      const signature = decodeBase64Url(signatureValue);
      if (
        iv === null ||
        authTag === null ||
        ciphertext === null ||
        signature === null ||
        iv.length !== IV_BYTES ||
        authTag.length !== AUTH_TAG_BYTES ||
        ciphertext.length === 0 ||
        signature.length !== SIGNATURE_BYTES
      ) {
        return null;
      }

      let rootKey: Buffer;
      let tokenDomain: string;
      let expectedPayloadVersion: 1 | 2;
      if (isKeyedToken) {
        if (keyId === undefined) return null;
        const keyRing = normalizeAndValidateKeyRing(
          dependencies.getKeyRing?.() ?? null,
        );
        const keyedRootKey = keyRing?.keys.get(keyId);
        if (keyedRootKey === undefined) {
          return null;
        }
        rootKey = keyedRootKey;
        tokenDomain = KEYED_TOKEN_DOMAIN;
        expectedPayloadVersion = KEYED_PAYLOAD_VERSION;
      } else {
        rootKey = dependencies.getRootKey();
        tokenDomain = LEGACY_TOKEN_DOMAIN;
        expectedPayloadVersion = LEGACY_PAYLOAD_VERSION;
      }

      const { encryptionKey, signingKey } = deriveTokenKeys(
        rootKey,
        tokenDomain,
      );
      const signedValue = parts.slice(0, -1).join(".");
      const expectedSignature = createHmac("sha256", signingKey)
        .update(signedValue, "utf8")
        .digest();
      if (!timingSafeEqual(signature, expectedSignature)) {
        return null;
      }

      let parsed: unknown;
      try {
        const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
        decipher.setAAD(getTokenAad(tokenVersion, keyId));
        decipher.setAuthTag(authTag);
        const plaintext = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]).toString("utf8");
        parsed = JSON.parse(plaintext) as unknown;
      } catch {
        return null;
      }

      const payload = parsePayload(parsed, expectedPayloadVersion);
      if (payload === null) {
        return null;
      }

      const expectedAudience = normalizeAndValidateAudience(
        dependencies.getAudience(),
      );
      if (
        payload.environment !== expectedAudience.environment ||
        payload.dataset !== expectedAudience.dataset
      ) {
        return null;
      }

      const now = toEpochSeconds(options?.now ?? getNow());
      // Unsubscribe links intentionally do not expire: recipients must always be
      // able to withdraw consent. Issuance in the future is still rejected.
      if (payload.issuedAt > now) {
        return null;
      }

      return {
        email: payload.email,
        issuedAt: new Date(payload.issuedAt * 1_000),
        tokenVersion: isKeyedToken ? KEYED_TOKEN_VERSION : LEGACY_TOKEN_VERSION,
      };
    },
  };
}

function parsePayload(
  value: unknown,
  expectedVersion: 1 | 2,
): MarketingUnsubscribePayload | null {
  if (!isRecord(value)) return null;

  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "dataset,email,environment,issuedAt,version") {
    return null;
  }

  if (
    value.version !== expectedVersion ||
    typeof value.email !== "string" ||
    typeof value.environment !== "string" ||
    typeof value.dataset !== "string" ||
    typeof value.issuedAt !== "number" ||
    !Number.isSafeInteger(value.issuedAt) ||
    value.issuedAt < 0
  ) {
    return null;
  }

  let email: string;
  let audience: { dataset: string; environment: string };
  try {
    email = normalizeAndValidateEmail(value.email);
    audience = normalizeAndValidateAudience({
      dataset: value.dataset,
      environment: value.environment,
    });
  } catch {
    return null;
  }

  if (email !== value.email) {
    return null;
  }

  return {
    dataset: audience.dataset,
    email,
    environment: audience.environment,
    issuedAt: value.issuedAt,
    version: expectedVersion,
  };
}

function normalizeAndValidateEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (
    email.length === 0 ||
    email.length > CONTACT_POPUP_CUSTOMER_EMAIL_MAX_LENGTH ||
    !EMAIL_PATTERN.test(email)
  ) {
    throw new Error("A valid marketing unsubscribe email is required");
  }
  return email;
}

function normalizeAndValidateAudience(input: {
  dataset: string;
  environment: string;
}): { dataset: string; environment: string } {
  const dataset = input.dataset.trim();
  const environment = input.environment.trim();
  if (
    dataset.length === 0 ||
    dataset.length > MAX_AUDIENCE_PART_LENGTH ||
    environment.length === 0 ||
    environment.length > MAX_AUDIENCE_PART_LENGTH
  ) {
    throw new Error("Marketing unsubscribe token audience is invalid");
  }
  return { dataset, environment };
}

function getCurrentAudience(): { dataset: string; environment: string } {
  return {
    dataset: process.env.NEXT_PUBLIC_SANITY_DATASET ?? "",
    environment:
      process.env.VERCEL_ENV?.trim() ||
      process.env.NODE_ENV?.trim() ||
      "development",
  };
}

function normalizeAndValidateKeyRing(
  keyRing: MarketingUnsubscribeTokenKeyRing | null,
): { currentKeyId: string; keys: ReadonlyMap<string, Buffer> } | null {
  if (keyRing === null) return null;
  if (!isValidKeyId(keyRing.currentKeyId)) {
    throw new Error("Marketing unsubscribe current key ID is invalid");
  }
  if (
    !Array.isArray(keyRing.keys) ||
    keyRing.keys.length === 0 ||
    keyRing.keys.length > MAX_KEY_RING_ENTRIES
  ) {
    throw new Error("Marketing unsubscribe token key ring is invalid");
  }

  const keys = new Map<string, Buffer>();
  for (const entry of keyRing.keys) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      !isValidKeyId(entry.id) ||
      !Buffer.isBuffer(entry.rootKey) ||
      entry.rootKey.length !== 32 ||
      keys.has(entry.id)
    ) {
      throw new Error("Marketing unsubscribe token key ring is invalid");
    }
    keys.set(entry.id, Buffer.from(entry.rootKey));
  }

  if (!keys.has(keyRing.currentKeyId)) {
    throw new Error(
      "Marketing unsubscribe current key ID is absent from the key ring",
    );
  }
  return { currentKeyId: keyRing.currentKeyId, keys };
}

function deriveTokenKeys(
  rootKey: Buffer,
  tokenDomain: string,
): {
  encryptionKey: Buffer;
  signingKey: Buffer;
} {
  if (rootKey.length !== 32) {
    throw new Error("Marketing unsubscribe token root key must be 32 bytes");
  }

  return {
    encryptionKey: createHmac("sha256", rootKey)
      .update(`${tokenDomain}/encryption`, "utf8")
      .digest(),
    signingKey: createHmac("sha256", rootKey)
      .update(`${tokenDomain}/signing`, "utf8")
      .digest(),
  };
}

function getTokenAad(tokenVersion: string, keyId?: string): Buffer {
  if (tokenVersion === LEGACY_TOKEN_VERSION && keyId === undefined) {
    return LEGACY_TOKEN_AAD;
  }
  if (tokenVersion === KEYED_TOKEN_VERSION && keyId && isValidKeyId(keyId)) {
    return Buffer.from(`${KEYED_TOKEN_DOMAIN}/payload/${keyId}`, "utf8");
  }
  throw new Error("Marketing unsubscribe token version or key ID is invalid");
}

function isValidKeyId(value: string): boolean {
  return value.length <= MAX_KEY_ID_LENGTH && KEY_ID_PATTERN.test(value);
}

function decodeCanonicalBase64Key(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    return null;
  }
  return decoded;
}

function toEpochSeconds(value: Date): number {
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new Error("Marketing unsubscribe token issuance time is invalid");
  }
  return Math.floor(milliseconds / 1_000);
}

function encodeBase64Url(value: Buffer): string {
  return value.toString("base64url");
}

function decodeBase64Url(value: string): Buffer | null {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;

  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
