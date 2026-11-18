import "server-only";
import { HighLevelError, type Journey } from "./contract";

export const PRODUCTION_LOCATION_ID = "vd09FLBpPLXuHb5Tnhn4";
export const HIGHLEVEL_ORIGIN = "https://services.leadconnectorhq.com";
export const HIGHLEVEL_SCOPES = [
  "contacts.readonly",
  "contacts.write",
  "opportunities.readonly",
  "opportunities.write",
  "workflows.readonly",
  "locations.readonly",
  "locations/customFields.readonly",
  "locations/tags.readonly",
  "users.readonly",
] as const;

export function crmSyncEnabled(): boolean {
  return (
    process.env.HIGHLEVEL_SYNC_ENABLED === "true" &&
    process.env.HIGHLEVEL_ACCOUNT_AUDITED === "true"
  );
}
export function crmMarketingEnabled(): boolean {
  return (
    process.env.HIGHLEVEL_MARKETING_ENABLED === "true" &&
    process.env.HIGHLEVEL_WORKFLOWS_REVIEWED === "true" &&
    highLevelOwnsMarketing() &&
    crmSyncEnabled()
  );
}
/** Provider ownership is independent of activation. Pausing never falls back to Resend. */
export function highLevelOwnsMarketing(): boolean {
  return process.env.MARKETING_DELIVERY_PROVIDER === "highlevel";
}
export function locationId(): string {
  const id = required("HIGHLEVEL_LOCATION_ID");
  const production =
    process.env.VERCEL_ENV === "production" ||
    (process.env.NODE_ENV === "production" && !process.env.VERCEL_ENV);
  if (production && id !== PRODUCTION_LOCATION_ID)
    throw new HighLevelError("wrong_production_location");
  if (!production && id === PRODUCTION_LOCATION_ID)
    throw new HighLevelError("production_location_forbidden_in_nonproduction");
  return id;
}
export function required(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new HighLevelError(`missing_${key.toLowerCase()}`);
  return value;
}
export function callbackUrl(): string {
  const url = new URL(required("HIGHLEVEL_REDIRECT_URI"));
  if (
    url.pathname !== "/api/admin/highlevel/callback" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && url.hostname === "localhost"))
  )
    throw new HighLevelError("invalid_redirect_uri");
  return url.href;
}
export function agencyInstallationEnabled(): boolean {
  return process.env.HIGHLEVEL_AGENCY_INSTALLATION_ENABLED === "true";
}
export function agencyCompanyId(): string {
  const id = required("HIGHLEVEL_COMPANY_ID");
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id))
    throw new HighLevelError("invalid_highlevel_company_id");
  return id;
}
export function authorizationUrl(state: string): URL {
  const version = required("HIGHLEVEL_APP_VERSION_ID");
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(version))
    throw new HighLevelError("invalid_highlevel_app_version_id");
  const url = new URL(
    "https://marketplace.gohighlevel.com/v2/oauth/chooselocation",
  );
  if (agencyInstallationEnabled()) agencyCompanyId();
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: required("HIGHLEVEL_CLIENT_ID"),
    redirect_uri: callbackUrl(),
    scope: [
      ...HIGHLEVEL_SCOPES,
      ...(agencyInstallationEnabled() ? ["oauth.write"] : []),
    ].join(" "),
    version_id: version,
    state,
  }).toString();
  return url;
}
export function fieldIds(): Record<string, string> {
  const fields: unknown = JSON.parse(required("HIGHLEVEL_FIELD_IDS"));
  if (
    !fields ||
    typeof fields !== "object" ||
    Array.isArray(fields) ||
    Object.values(fields).some(
      (v) => typeof v !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(v),
    )
  )
    throw new HighLevelError("invalid_field_mapping");
  for (const key of [
    "website_id",
    "email_eligible",
    "sms_eligible",
    "email_destination",
    "sms_destination",
    "original_source",
    "original_path",
    "attribution",
    "source",
    "source_path",
    "historical",
    "lifecycle",
    "interest",
    "last_activity",
    "offer",
    "offer_code",
    "offer_label",
    "offer_terms",
    "offer_url",
    "journey_key",
  ]) {
    if (!(key in fields)) throw new HighLevelError(`missing_field_${key}`);
  }
  if (new Set(Object.values(fields)).size !== Object.values(fields).length)
    throw new HighLevelError("duplicate_field_mapping");
  return fields as Record<string, string>;
}
export function workflowId(journey: Journey): string | null {
  const value =
    process.env[`HIGHLEVEL_WORKFLOW_${journey.toUpperCase()}_ID`]?.trim();
  return value && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : null;
}
export function crmUrl(): string {
  const id = process.env.HIGHLEVEL_LOCATION_ID;
  return id && /^[a-zA-Z0-9_-]+$/.test(id)
    ? `https://app.gohighlevel.com/v2/location/${id}/contacts/smart_list/All`
    : "https://app.gohighlevel.com/";
}
