const DEFAULT_ADMIN_RETURN_TO = "/admin";

export function getSafeAdminReturnTo(value: unknown): string {
  if (typeof value !== "string") {
    return DEFAULT_ADMIN_RETURN_TO;
  }

  if (
    !value.startsWith("/admin")
    || value.startsWith("//")
    || value.startsWith("/admin/sign-in")
    || value.includes("\\")
  ) {
    return DEFAULT_ADMIN_RETURN_TO;
  }

  return value;
}
