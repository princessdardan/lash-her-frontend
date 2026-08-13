import { NextResponse, type NextRequest } from "next/server";
import {
  exchangeAddressChangeToken,
  getAddressChange,
  submitAddressChange,
} from "@/lib/shipping/address-changes";
import { buildBookingAbuseKey } from "@/lib/security/trusted-client-ip";
import { checkSignedShippingLinkRateLimit } from "@/lib/security/shipping-abuse-control";
import type { CheckoutOrderShippingAddressSnapshot } from "@/lib/private-db/schema";

export const runtime = "nodejs";
const COOKIE = "lh_address_change";

export async function GET(req: NextRequest): Promise<Response> {
  const token = req.nextUrl.searchParams.get("token");
  if (token) {
    if (!(await allowed(req, token))) return genericInvalid();
    const sessionToken = await exchangeAddressChangeToken(token);
    if (!sessionToken) return genericInvalid();
    const response = NextResponse.redirect(
      new URL("/orders/address-change", req.nextUrl.origin),
      303,
    );
    response.cookies.set(COOKIE, sessionToken, cookieOptions());
    return secure(response);
  }
  const sessionToken = req.cookies.get(COOKIE)?.value ?? "";
  const request = sessionToken ? await getAddressChange(sessionToken) : null;
  if (!request) return genericInvalid();
  const address = request.originalAddress;
  return html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Change shipping address | Lash Her</title></head><body><main><h1>Change shipping address</h1><p>Current destination: ${escapeHtml(maskAddress(address))}</p><p>Submit the complete corrected address. It will be reviewed before use.</p><form method="post" action="/orders/address-change">${field("line1", "Address line 1", "", true)}${field("line2", "Address line 2", "", false)}${field("city", "City", "", true)}${field("province", "Province or state code", "", true)}${field("postalCode", "Postal or ZIP code", "", true)}<label>Country <select name="countryCode" required><option value="CA"${countryCode(address) === "CA" ? " selected" : ""}>Canada</option><option value="US"${countryCode(address) === "US" ? " selected" : ""}>United States</option></select></label><br><button type="submit">Submit address</button></form><p>This secure link expires ${escapeHtml(request.expiresAt.toLocaleString("en-CA", { timeZone: "America/Toronto" }))}.</p></main></body></html>`,
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  if (req.headers.get("origin") !== req.nextUrl.origin) return genericInvalid();
  const sessionToken = req.cookies.get(COOKIE)?.value ?? "";
  const form = await req.formData().catch(() => null);
  const proposedAddress = form ? parseAddress(form) : null;
  if (
    !sessionToken ||
    !proposedAddress ||
    !(await allowed(req, sessionToken)) ||
    !(await submitAddressChange({ sessionToken, proposedAddress }))
  )
    return genericInvalid();
  const response = html(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Address received | Lash Her</title></head><body><main><h1>Your address was received</h1><p>The change is pending review. No further changes can be submitted with this link.</p></main></body></html>',
  );
  response.cookies.delete(COOKIE);
  return response;
}

function parseAddress(
  form: FormData,
): CheckoutOrderShippingAddressSnapshot | null {
  const get = (name: string, max: number) => {
    const value = form.get(name);
    return typeof value === "string" ? value.trim().slice(0, max) : "";
  };
  const line1 = get("line1", 120);
  const line2 = get("line2", 120);
  const city = get("city", 80);
  const province = get("province", 2).toUpperCase();
  const postalCode = get("postalCode", 20).toUpperCase();
  const code = get("countryCode", 2).toUpperCase();
  if (
    !line1 ||
    !city ||
    !postalCode ||
    !/^[A-Z]{2}$/.test(province) ||
    !["CA", "US"].includes(code)
  )
    return null;
  return {
    line1,
    ...(line2 ? { line2 } : {}),
    city,
    province,
    postalCode,
    country: code === "CA" ? "Canada" : "United States",
    countryCode: code as "CA" | "US",
  };
}

function field(
  name: string,
  label: string,
  value: string,
  required: boolean,
): string {
  return `<label>${escapeHtml(label)} <input name="${name}" value="${escapeHtml(value)}"${required ? " required" : ""}></label><br>`;
}

async function allowed(req: NextRequest, subject: string): Promise<boolean> {
  const subjectKey = buildBookingAbuseKey({
    headers: req.headers,
    scope: "address-changes",
    subject,
  });
  const ipKey = buildBookingAbuseKey({
    headers: req.headers,
    scope: "address-changes",
    subject: "all-links",
  });
  if (!subjectKey || !ipKey) return false;
  try {
    const now = new Date();
    const [subjectDecision, ipDecision] = await Promise.all([
      checkSignedShippingLinkRateLimit({ key: subjectKey, now }),
      checkSignedShippingLinkRateLimit({ key: ipKey, now }),
    ]);
    return subjectDecision.allowed && ipDecision.allowed;
  } catch {
    return false;
  }
}

function countryCode(address: CheckoutOrderShippingAddressSnapshot): string {
  return (
    address.countryCode ??
    (address.country.toUpperCase() === "CANADA" ? "CA" : "US")
  );
}

function maskAddress(address: CheckoutOrderShippingAddressSnapshot): string {
  const postalPrefix = address.postalCode.replace(/\s+/g, "").slice(0, 3);
  return `${countryCode(address) === "CA" ? "Canada" : "United States"}, ${postalPrefix || "postal area"}…`;
}

function genericInvalid(): NextResponse {
  return html(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link unavailable | Lash Her</title></head><body><main><h1>This link is unavailable</h1><p>It may be invalid, expired, or already used.</p></main></body></html>',
    404,
  );
}

function html(body: string, status = 200): NextResponse {
  return secure(
    new NextResponse(body, {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }),
  );
}

function secure<T extends NextResponse>(response: T): T {
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  return response;
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "strict" as const,
    path: "/orders/address-change",
    maxAge: 30 * 60,
  };
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[character]!,
  );
}
