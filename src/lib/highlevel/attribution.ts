const KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
] as const;
export type CampaignAttribution = Partial<
  Record<(typeof KEYS)[number], string>
>;

/** Whitelist campaign parameters; never copy query strings, referrer tokens or cookies. */
export function sanitizeAttribution(value: unknown): CampaignAttribution {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  return Object.fromEntries(
    KEYS.flatMap((key) =>
      typeof input[key] === "string" && input[key].trim()
        ? [
            [
              key,
              input[key]
                .replace(/[\u0000-\u001f\u007f]/g, "")
                .trim()
                .slice(0, 200),
            ],
          ]
        : [],
    ),
  );
}

export function currentCampaignAttribution(): CampaignAttribution {
  if (typeof window === "undefined") return {};
  return sanitizeAttribution(
    Object.fromEntries(new URLSearchParams(window.location.search)),
  );
}
