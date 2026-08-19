export function renderCustomerDecisionConditions(
  kind: string,
  scopeKey: string,
  conditions: Record<string, unknown> | null | undefined,
): string {
  if (kind === "service_substitution" && conditions) {
    const original =
      typeof conditions.originalPostageType === "string"
        ? conditions.originalPostageType
        : "the originally selected service";
    const substitute =
      typeof conditions.substitutePostageType === "string"
        ? conditions.substitutePostageType
        : "the substitute service";
    const amount =
      typeof conditions.substituteAmountCents === "number"
        ? new Intl.NumberFormat("en-CA", {
            style: "currency",
            currency: "CAD",
          }).format(conditions.substituteAmountCents / 100)
        : "an unavailable amount";
    return `<p>The original service, <strong>${escapeHtml(original)}</strong>, is unavailable for the changed address.</p><p>Substitute service: <strong>${escapeHtml(substitute)}</strong><br>Quoted shipping amount: <strong>${escapeHtml(amount)}</strong></p><p>This acceptance applies only to these exact terms.</p>`;
  }
  if (kind === "signature_requirement") {
    return "<p>The changed address requires signature delivery. Shipment preparation will resume only if you accept this requirement.</p>";
  }
  return `<p>Decision scope: <code>${escapeHtml(scopeKey)}</code></p><pre>${escapeHtml(JSON.stringify(conditions ?? {}, null, 2))}</pre>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
