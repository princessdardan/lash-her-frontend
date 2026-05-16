import type { TLink } from "@/types";

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

export function getSafeHref(href?: string): string | null {
  const value = href?.trim();
  if (!value || value.startsWith("//")) return null;

  if (value.startsWith("/") || value.startsWith("#")) {
    return value;
  }

  try {
    const url = new URL(value);
    return SAFE_PROTOCOLS.has(url.protocol) ? value : null;
  } catch {
    return null;
  }
}

export function getSafeLinks(links?: TLink[]): TLink[] {
  return links?.filter((link) => getSafeHref(link.href)) ?? [];
}
