export interface AcademyPrincipal {
  email: string;
  userId: string;
}

export interface AcademySessionLike {
  user?: {
    email?: unknown;
    id?: unknown;
    isEmailVerified?: unknown;
  } | null;
}

export function getAcademyPrincipal(
  session: AcademySessionLike | null | undefined,
): AcademyPrincipal | null {
  const user = session?.user;
  if (
    !user ||
    typeof user.id !== "string" ||
    !user.id.trim() ||
    typeof user.email !== "string" ||
    !user.email.trim() ||
    user.isEmailVerified !== true
  ) {
    return null;
  }

  return { email: user.email.trim(), userId: user.id.trim() };
}
