import "server-only";

export interface ChitChatsConfig {
  accessToken: string;
  baseUrl: string;
  clientId: string;
  environment: "staging" | "production";
  quoteSigningSecret: string;
  trackedPostageTypes: ReadonlySet<string>;
  usShippingEnabled: boolean;
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

export function isSupplementalProductPaymentsEnabled(): boolean {
  return process.env.SUPPLEMENTAL_PRODUCT_PAYMENTS_ENABLED === "true";
}

export function getChitChatsConfig(): ChitChatsConfig {
  const environment = process.env.CHITCHATS_ENVIRONMENT ?? "staging";
  if (environment !== "staging" && environment !== "production") {
    throw new Error("CHITCHATS_ENVIRONMENT must be staging or production");
  }

  if (process.env.VERCEL_ENV === "production" && environment !== "production") {
    throw new Error("Production deployment cannot use Chit Chats staging");
  }

  const clientId = required("CHITCHATS_CLIENT_ID");
  const host =
    environment === "production"
      ? "https://chitchats.com"
      : "https://staging.chitchats.com";
  const configuredTypes = process.env.CHITCHATS_TRACKED_POSTAGE_TYPES?.split(
    ",",
  )
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    accessToken: required("CHITCHATS_ACCESS_TOKEN"),
    baseUrl: `${host}/api/v1/clients/${encodeURIComponent(clientId)}`,
    clientId,
    environment,
    quoteSigningSecret: required("CHITCHATS_QUOTE_SIGNING_SECRET"),
    trackedPostageTypes: new Set(
      configuredTypes?.length ? configuredTypes : DEFAULT_TRACKED_POSTAGE_TYPES,
    ),
    usShippingEnabled: process.env.CHITCHATS_US_SHIPPING_ENABLED === "true",
  };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}
