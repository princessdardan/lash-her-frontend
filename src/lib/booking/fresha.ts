/** Public service booking destination. Never append internal booking references. */
export const FRESHA_BOOKING_URL =
  "https://www.fresha.com/a/lash-her-by-nataliea-toronto-646-oakwood-avenue-tvrir5sx";

export const FRESHA_BOOKING_LABEL = "Book on Fresha";
export const SERVICE_BOOKING_MOVED_MESSAGE =
  "New service bookings are now managed on Fresha. Existing bookings remain valid.";

export function serviceBookingMovedResponse(request: Request): Response {
  void request;
  return Response.json(
    {
      code: "SERVICE_BOOKING_MOVED",
      error: SERVICE_BOOKING_MOVED_MESSAGE,
      bookingUrl: FRESHA_BOOKING_URL,
    },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}

export function isServiceBookingEntryPath(pathname: string): boolean {
  return (
    /^\/booking\/?$/.test(pathname) ||
    /^\/services\/[^/]+\/booking\/?$/.test(pathname)
  );
}

/** Match entry points only; payment, confirmation, product and training URLs survive. */
export function isServiceBookingEntryHref(
  href: string,
  label?: string,
): boolean {
  const value = href.trim();
  if (value.startsWith("//")) return false;
  try {
    const url = new URL(value, "https://lashher.com");
    if (!["https:", "http:"].includes(url.protocol)) return false;
    if (url.origin === "https://www.fresha.com") {
      return (
        url.pathname === new URL(FRESHA_BOOKING_URL).pathname ||
        url.pathname === `${new URL(FRESHA_BOOKING_URL).pathname}/all-offer`
      );
    }
    if (!["lashher.com", "www.lashher.com"].includes(url.hostname))
      return false;
    return (
      isServiceBookingEntryPath(url.pathname) ||
      (/^\/services\/?$/.test(url.pathname) &&
        /^book(?:\s+(?:now|an? appointment|appointment|a service|services?))?$/i.test(
          label?.trim() ?? "",
        ))
    );
  } catch {
    return false;
  }
}

/** Rewrite CMS link objects without changing stored editorial content. */
export function withFreshaBookingLinks<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withFreshaBookingLinks) as T;
  if (!value || typeof value !== "object") return value;

  const result = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      withFreshaBookingLinks(child),
    ]),
  );
  for (const key of ["href", "url"]) {
    const label = [result.label, result.title, result.name].find(
      (value) => typeof value === "string",
    );
    if (
      typeof result[key] !== "string" ||
      !isServiceBookingEntryHref(result[key], label as string | undefined)
    )
      continue;
    result[key] = FRESHA_BOOKING_URL;
    for (const labelKey of ["label", "title", "name"]) {
      if (typeof result[labelKey] === "string")
        result[labelKey] = FRESHA_BOOKING_LABEL;
    }
    if ("isExternal" in result) result.isExternal = true;
    if ("linkType" in result) result.linkType = "external";
  }
  return result as T;
}
