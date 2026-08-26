import "server-only";

export const CHITCHATS_REGIONS = [
  "british_columbia",
  "alberta_saskatchewan",
  "ontario_manitoba",
  "quebec",
  "atlantic",
] as const;

export type ChitChatsRegion = (typeof CHITCHATS_REGIONS)[number];
export type ChitChatsEnvironment = "staging" | "production";

export const CHITCHATS_REGION_LABELS = {
  british_columbia: "British Columbia",
  alberta_saskatchewan: "Alberta and Saskatchewan",
  ontario_manitoba: "Ontario and Manitoba",
  quebec: "Quebec",
  atlantic: "Atlantic",
} as const satisfies Record<ChitChatsRegion, string>;

export interface ChitChatsConfig {
  accessToken: string;
  baseUrl: string;
  clientId: string;
  environment: ChitChatsEnvironment;
  quoteSigningSecret: string;
  trackedPostageTypes: ReadonlySet<string>;
  usShippingEnabled: boolean;
}

export type ConfiguredChitChatsConfig = ChitChatsConfig & {
  region: ChitChatsRegion;
};

export interface ChitChatsOperationalIdentity {
  clientId: string;
  environment: ChitChatsEnvironment;
  region: ChitChatsRegion;
}

const DEFAULT_TRACKED_POSTAGE_TYPES = [
  "chit_chats_canada_tracked",
  "chit_chats_select",
  "chit_chats_us_edge",
  "chit_chats_us_connect",
  "chit_chats_us_select",
  "canada_post_tracked_packet_usa",
  "canada_post_expedited_parcel_usa",
  "usps_ground_advantage",
  "usps_priority",
  "usps_express",
];

export function isChitChatsShippingEnabled(): boolean {
  return process.env.CHITCHATS_SHIPPING_ENABLED === "true";
}

export function isChitChatsCheckoutEnabled(): boolean {
  return (
    isChitChatsShippingEnabled() &&
    process.env.CHITCHATS_CHECKOUT_ENABLED === "true"
  );
}

export function isManualProductCheckoutEnabled(): boolean {
  return process.env.MANUAL_PRODUCT_CHECKOUT_ENABLED === "true";
}

/**
 * When enabled, customer-facing shipping cost is served synchronously from the
 * precomputed flat-rate cache instead of a live per-order Chit Chats quote.
 * Gated so the flat-rate flow can be rolled out and rolled back independently.
 */
export function isFlatRateShippingEnabled(): boolean {
  return process.env.FLAT_RATE_SHIPPING_ENABLED === "true";
}

export interface ProductCheckoutAvailability {
  automated: boolean;
  manual: boolean;
}

/**
 * Whether each product checkout mode is currently enabled. Storefront buy
 * controls consult this so they don't present active CTAs that dead-end at a
 * 503 when checkout is disabled.
 */
export function getProductCheckoutAvailability(): ProductCheckoutAvailability {
  return {
    automated: isChitChatsCheckoutEnabled(),
    manual: isManualProductCheckoutEnabled(),
  };
}

export function isSupplementalProductPaymentsEnabled(): boolean {
  return process.env.SUPPLEMENTAL_PRODUCT_PAYMENTS_ENABLED === "true";
}

export function getChitChatsConfig(): ConfiguredChitChatsConfig {
  const identity = getChitChatsOperationalIdentity();
  const host =
    identity.environment === "production"
      ? "https://chitchats.com"
      : "https://staging.chitchats.com";
  const configuredTypes = process.env.CHITCHATS_TRACKED_POSTAGE_TYPES?.split(
    ",",
  )
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    accessToken: required("CHITCHATS_ACCESS_TOKEN"),
    baseUrl: `${host}/api/v1/clients/${encodeURIComponent(identity.clientId)}`,
    clientId: identity.clientId,
    environment: identity.environment,
    quoteSigningSecret: required("CHITCHATS_QUOTE_SIGNING_SECRET"),
    region: identity.region,
    trackedPostageTypes: new Set(
      configuredTypes?.length ? configuredTypes : DEFAULT_TRACKED_POSTAGE_TYPES,
    ),
    usShippingEnabled: process.env.CHITCHATS_US_SHIPPING_ENABLED === "true",
  };
}

export function getChitChatsOperationalIdentity(): ChitChatsOperationalIdentity {
  const environment = process.env.CHITCHATS_ENVIRONMENT ?? "staging";
  if (environment !== "staging" && environment !== "production") {
    throw new Error("CHITCHATS_ENVIRONMENT must be staging or production");
  }
  if (process.env.VERCEL_ENV === "production" && environment !== "production") {
    throw new Error("Production deployment cannot use Chit Chats staging");
  }
  return {
    clientId: required("CHITCHATS_CLIENT_ID"),
    environment,
    region: getConfiguredChitChatsRegion(),
  };
}

export function parseChitChatsRegion(value: string): ChitChatsRegion {
  const region = value.trim();
  if ((CHITCHATS_REGIONS as readonly string[]).includes(region)) {
    return region as ChitChatsRegion;
  }

  throw new Error(
    `CHITCHATS_REGION must be one of ${CHITCHATS_REGIONS.join(", ")}`,
  );
}

export function getConfiguredChitChatsRegion(): ChitChatsRegion {
  return parseChitChatsRegion(required("CHITCHATS_REGION"));
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}
