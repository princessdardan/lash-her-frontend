import "server-only";

import { createHmac } from "node:crypto";

const CURRENT_KEY_ENV = "CONTACT_POPUP_OFFER_DEDUPE_CURRENT_KEY";
const PREVIOUS_KEYS_ENV = "CONTACT_POPUP_OFFER_DEDUPE_PREVIOUS_KEYS";
const LEGACY_KEYS_ENV = "CONTACT_POPUP_OFFER_DEDUPE_LEGACY_CHECKOUT_KEYS";
const LEGACY_KEY_ENV = "CHECKOUT_SECRET_ENCRYPTION_KEY";
const MAX_RETAINED_KEYS = 32;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

interface ContactPopupOfferDedupeInput {
  emailNormalized: string;
  promotionId: string;
}

export interface ContactPopupOfferDedupeKeys {
  candidateProviderIdempotencyKeys: string[];
  primaryProviderIdempotencyKey: string;
}

interface VersionedKey {
  key: Buffer;
  version: string;
}

/**
 * Returns the key used for a new grant plus every retained key that can identify
 * an earlier grant. The checkout-derived candidate preserves rows created before
 * the dedicated keyring existed.
 */
export function buildContactPopupOfferDedupeKeys(
  input: ContactPopupOfferDedupeInput,
): ContactPopupOfferDedupeKeys {
  const currentValue = process.env[CURRENT_KEY_ENV]?.trim();
  const previousValue = process.env[PREVIOUS_KEYS_ENV]?.trim();
  const legacyValue = process.env[LEGACY_KEY_ENV]?.trim();
  const retainedLegacyKeys = parseLegacyKeys(process.env[LEGACY_KEYS_ENV]);
  const previous = parsePreviousKeys(previousValue);
  assertUniqueVersions(previous);

  if (!currentValue) {
    const legacyKey = parseBase64Key(LEGACY_KEY_ENV, legacyValue);
    const legacyProviderKey = deriveLegacyProviderKey(input, legacyKey);
    return {
      candidateProviderIdempotencyKeys: [
        ...new Set([
          legacyProviderKey,
          ...previous.map((entry) => deriveVersionedProviderKey(input, entry)),
          ...retainedLegacyKeys.map((key) =>
            deriveLegacyProviderKey(input, key),
          ),
        ]),
      ],
      primaryProviderIdempotencyKey: legacyProviderKey,
    };
  }

  const current = parseVersionedKey(CURRENT_KEY_ENV, currentValue);
  const versions = new Set([current.version]);

  for (const entry of previous) {
    if (versions.has(entry.version)) {
      throw new Error(
        `${PREVIOUS_KEYS_ENV} contains duplicate key version: ${entry.version}`,
      );
    }
    versions.add(entry.version);
  }

  const primaryProviderIdempotencyKey = deriveVersionedProviderKey(
    input,
    current,
  );
  const candidates = [
    primaryProviderIdempotencyKey,
    ...previous.map((entry) => deriveVersionedProviderKey(input, entry)),
  ];

  if (legacyValue) {
    candidates.push(
      deriveLegacyProviderKey(
        input,
        parseBase64Key(LEGACY_KEY_ENV, legacyValue),
      ),
    );
  }
  candidates.push(
    ...retainedLegacyKeys.map((key) => deriveLegacyProviderKey(input, key)),
  );

  return {
    candidateProviderIdempotencyKeys: [...new Set(candidates)],
    primaryProviderIdempotencyKey,
  };
}

function assertUniqueVersions(entries: VersionedKey[]): void {
  const versions = new Set<string>();
  for (const entry of entries) {
    if (versions.has(entry.version)) {
      throw new Error(
        `${PREVIOUS_KEYS_ENV} contains duplicate key version: ${entry.version}`,
      );
    }
    versions.add(entry.version);
  }
}

function parseLegacyKeys(value: string | undefined): Buffer[] {
  if (!value?.trim()) return [];

  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length > MAX_RETAINED_KEYS) {
    throw new Error(
      `${LEGACY_KEYS_ENV} supports at most ${MAX_RETAINED_KEYS} keys`,
    );
  }

  return entries.map((entry) => parseBase64Key(LEGACY_KEYS_ENV, entry));
}

function parsePreviousKeys(value: string | undefined): VersionedKey[] {
  if (!value) return [];

  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length > MAX_RETAINED_KEYS) {
    throw new Error(
      `${PREVIOUS_KEYS_ENV} supports at most ${MAX_RETAINED_KEYS} keys`,
    );
  }

  return entries.map((entry) => parseVersionedKey(PREVIOUS_KEYS_ENV, entry));
}

function parseVersionedKey(name: string, value: string): VersionedKey {
  const separatorIndex = value.indexOf(":");
  const version = value.slice(0, separatorIndex);
  const encodedKey = value.slice(separatorIndex + 1);

  if (separatorIndex <= 0 || !VERSION_PATTERN.test(version)) {
    throw new Error(
      `Malformed env var: ${name} must use version:base64-key format`,
    );
  }

  return {
    key: parseBase64Key(name, encodedKey),
    version,
  };
}

function parseBase64Key(name: string, value: string | undefined): Buffer {
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }

  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) {
    throw new Error(
      `Malformed env var: ${name} must contain base64-encoded 32-byte keys`,
    );
  }

  return key;
}

function deriveVersionedProviderKey(
  input: ContactPopupOfferDedupeInput,
  versionedKey: VersionedKey,
): string {
  return deriveProviderKey(
    input,
    versionedKey.key,
    `lash-her/contact-popup-offer/dedupe/v2\0${versionedKey.version}\0`,
  );
}

function deriveLegacyProviderKey(
  input: ContactPopupOfferDedupeInput,
  key: Buffer,
): string {
  return deriveProviderKey(input, key, "lash-her/contact-popup-offer/v1\0");
}

function deriveProviderKey(
  input: ContactPopupOfferDedupeInput,
  key: Buffer,
  domain: string,
): string {
  const environment =
    process.env.VERCEL_ENV?.trim() ||
    process.env.NODE_ENV?.trim() ||
    "development";
  const sanityDataset =
    process.env.NEXT_PUBLIC_SANITY_DATASET?.trim() || "unconfigured";
  const digest = createHmac("sha256", key)
    .update(domain, "utf8")
    .update(environment)
    .update("\0")
    .update(sanityDataset)
    .update("\0")
    .update(input.emailNormalized.trim().toLowerCase())
    .update("\0")
    .update(input.promotionId.trim())
    .digest("hex");

  return `contact-popup-offer:${digest}`;
}
