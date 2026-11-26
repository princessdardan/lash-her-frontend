import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  callbackUrl,
  authorizationUrl,
  HIGHLEVEL_ORIGIN,
  HIGHLEVEL_SCOPES,
  locationId,
  required,
  agencyInstallationEnabled,
  agencyCompanyId,
} from "./config";
import { decryptCredential, encryptCredential } from "./crypto";
import { HighLevelError } from "./contract";

interface Credentials {
  access_token: string;
  refresh_token: string;
}
export interface TokenResponse extends Credentials {
  expires_in: number;
  locationId: string;
  userType: string;
  scope: string;
  companyId?: string;
}
export const stateHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export async function createInstallation(
  actorId: string,
): Promise<{ url: string; state: string }> {
  locationId();
  const state = randomBytes(32).toString("base64url");
  const url = authorizationUrl(state);
  await getPrivateDb().execute(
    sql`insert into highlevel_oauth_states (hash, actor_id, expires_at) values (${stateHash(state)}, ${actorId}::uuid, now() + interval '10 minutes')`,
  );
  return { url: url.href, state };
}

export async function exchange(
  values: Record<string, string>,
  request: typeof fetch = fetch,
): Promise<TokenResponse> {
  const response = await request(`${HIGHLEVEL_ORIGIN}/oauth/token`, {
    method: "POST",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Version: "v3",
    },
    body: new URLSearchParams({
      client_id: required("HIGHLEVEL_CLIENT_ID"),
      client_secret: required("HIGHLEVEL_CLIENT_SECRET"),
      user_type: "Location",
      redirect_uri: callbackUrl(),
      ...values,
    }),
  });
  if (!response.ok) throw new HighLevelError(`oauth_http_${response.status}`);
  let token = (await response.json()) as TokenResponse;
  if (token.userType === "Company") {
    // Agency installers receive a Company token under mandatory bulk install.
    // Use it only for this one configured location; never store agency credentials.
    if (
      values.grant_type !== "authorization_code" ||
      !agencyInstallationEnabled()
    )
      throw new HighLevelError("oauth_location_installation_required");
    if (token.companyId !== agencyCompanyId() || !token.access_token)
      throw new HighLevelError("oauth_invalid_company_or_token");
    if (!token.scope?.split(/[ ,]+/).includes("oauth.write"))
      throw new HighLevelError("oauth_missing_agency_exchange_scope");
    const locationResponse = await request(
      `${HIGHLEVEL_ORIGIN}/oauth/location-token`,
      {
        method: "POST",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          Version: "v3",
          Authorization: `Bearer ${token.access_token}`,
        },
        body: new URLSearchParams({
          companyId: agencyCompanyId(),
          locationId: locationId(),
        }),
      },
    );
    if (!locationResponse.ok)
      throw new HighLevelError(
        `oauth_location_token_http_${locationResponse.status}`,
      );
    token = (await locationResponse.json()) as TokenResponse;
    // This endpoint's documented response omits userType. Only its exact,
    // validated location response may be normalized to a Location token.
    token = { ...token, userType: token.userType ?? "Location" };
  }
  if (
    token.locationId !== locationId() ||
    token.userType !== "Location" ||
    !token.access_token ||
    !token.refresh_token ||
    !Number.isFinite(token.expires_in) ||
    token.expires_in <= 0
  )
    throw new HighLevelError("oauth_invalid_location_or_token");
  const scopes = new Set(token.scope?.split(/[ ,]+/));
  if (HIGHLEVEL_SCOPES.some((scope) => !scopes.has(scope)))
    throw new HighLevelError("oauth_missing_scopes");
  return token;
}

export async function completeInstallation(
  actorId: string,
  state: string,
  code: string,
): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{43}$/.test(state) || !code || code.length > 4096)
    throw new HighLevelError("invalid_oauth_callback");
  const claimed = await getPrivateDb().execute(
    sql`delete from highlevel_oauth_states where hash = ${stateHash(state)} and actor_id = ${actorId}::uuid and expires_at > now() returning hash`,
  );
  if (!claimed.rows.length) throw new HighLevelError("expired_oauth_state");
  const token = await exchange({ grant_type: "authorization_code", code });
  const ciphertext = encryptCredential(
    { access_token: token.access_token, refresh_token: token.refresh_token },
    locationId(),
  );
  await getPrivateDb()
    .execute(sql`insert into highlevel_connections (location_id, credentials_ciphertext, expires_at, installed_by) values (${locationId()}, ${ciphertext}, ${new Date(Date.now() + token.expires_in * 1000)}, ${actorId}::uuid)
    on conflict (location_id) do update set credentials_ciphertext = excluded.credentials_ciphertext, expires_at = excluded.expires_at, installed_by = excluded.installed_by, refresh_state = 'ready', updated_at = now()`);
}

export async function accessToken(
  exchangeToken: typeof exchange = exchange,
): Promise<string> {
  const id = locationId();
  const db = getPrivateDb();
  const result = await db.execute<{
    credentials_ciphertext: string;
    expires_at: Date;
    refresh_state: string;
    updated_at: Date;
  }>(sql`select * from highlevel_connections where location_id = ${id}`);
  const row = result.rows[0];
  if (!row) throw new HighLevelError("oauth_installation_required");
  if (row.refresh_state !== "ready") {
    if (
      row.refresh_state === "refreshing" &&
      Date.now() - new Date(row.updated_at).getTime() < 120_000
    )
      throw new HighLevelError("oauth_refresh_in_progress", true);
    throw new HighLevelError("oauth_reinstallation_required");
  }
  const credentials = decryptCredential<Credentials>(
    row.credentials_ciphertext,
    id,
  );
  if (new Date(row.expires_at).getTime() > Date.now() + 60_000)
    return credentials.access_token;
  // Durable claim BEFORE rotating a single-use refresh token. A lost response requires
  // reinstallation; another worker must never replay an uncertain refresh request.
  const claim = await db.execute(
    sql`update highlevel_connections set refresh_state = 'refreshing', updated_at = now() where location_id = ${id} and refresh_state = 'ready' and credentials_ciphertext = ${row.credentials_ciphertext} returning location_id`,
  );
  if (!claim.rows.length)
    throw new HighLevelError("oauth_refresh_in_progress", true);
  try {
    const token = await exchangeToken({
      grant_type: "refresh_token",
      refresh_token: credentials.refresh_token,
    });
    const ciphertext = encryptCredential(
      { access_token: token.access_token, refresh_token: token.refresh_token },
      id,
    );
    const saved = await db.execute(
      sql`update highlevel_connections set credentials_ciphertext = ${ciphertext}, expires_at = ${new Date(Date.now() + token.expires_in * 1000)}, refresh_state = 'ready', updated_at = now() where location_id = ${id} and refresh_state = 'refreshing' and credentials_ciphertext = ${row.credentials_ciphertext} returning location_id`,
    );
    if (!saved.rows.length)
      throw new HighLevelError("oauth_installation_changed");
    return token.access_token;
  } catch {
    await db.execute(
      sql`update highlevel_connections set refresh_state = 'reconnect', updated_at = now() where location_id = ${id} and credentials_ciphertext = ${row.credentials_ciphertext}`,
    );
    throw new HighLevelError("oauth_reinstallation_required");
  }
}
