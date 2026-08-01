const MAX_SERVICE_IDENTIFIER_LENGTH = 100;

export function createServiceIdentifier(displayTitle: string): string {
  return displayTitle
    .trim()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-CA")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SERVICE_IDENTIFIER_LENGTH)
    .replace(/-+$/g, "");
}
