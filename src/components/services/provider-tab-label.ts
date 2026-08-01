export function getProviderTabLabel(displayName: string): string {
  return displayName.trim().split(/\s+/, 1)[0] ?? "";
}
