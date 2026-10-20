/** Non-secret tracking policy. No OAuth, contact identifiers, or SDK globals. */
export function highLevelTrackingStatus(flag: string | undefined) {
  return {
    requested: flag === "true",
    enabled: false as const,
    reason: "vendor_verification_required" as const,
  };
}

// Candidate routes only. No embed is installed. Additional public CMS pages need
// explicit review; arbitrary slugs can themselves contain private identifiers.
const APPROVED_PATHS = new Set([
  "/",
  "/gallery",
  "/products",
  "/services",
  "/training-programs",
]);

export function isApprovedHighLevelTrackingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      ["lashher.com", "www.lashher.com"].includes(url.hostname) &&
      !url.port &&
      !url.username &&
      !url.password &&
      // The current vendor script reads the raw URL. Sanitizing a copy cannot
      // protect it. Reject ALL queries and fragments, even UTM-labelled PII.
      !url.search &&
      !url.hash &&
      APPROVED_PATHS.has(url.pathname)
    );
  } catch {
    return false;
  }
}
