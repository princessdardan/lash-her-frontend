import {
  CUSTOMER_IDENTITY_PROVIDER,
  CustomerIdentityConflictError,
  CustomerIdentityResolutionError,
  type CustomerIdentityResolutionInput,
} from "./types";

interface JwtTokenShape {
  customerUserId?: unknown;
  googleEmailVerified?: unknown;
  providerUserId?: unknown;
  sub?: unknown;
}

interface AccountShape {
  provider?: unknown;
  providerAccountId?: unknown;
}

interface GoogleProfileShape {
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  sub?: unknown;
}

interface JwtIdentityCallbackInput<Token extends JwtTokenShape> {
  account?: AccountShape | null;
  profile?: GoogleProfileShape;
  resolveIdentity: (input: CustomerIdentityResolutionInput) => Promise<string>;
  token: Token;
}

interface SessionShape {
  user?: {
    id?: string;
  };
}

export async function applyCustomerIdentityToJwt<Token extends JwtTokenShape>(
  input: JwtIdentityCallbackInput<Token>,
): Promise<Token & JwtTokenShape> {
  const { account, profile, token } = input;

  if (account !== null && account !== undefined && profile !== undefined) {
    if (account.provider !== CUSTOMER_IDENTITY_PROVIDER) {
      return preserveLegacyStaffIdentity(token);
    }

    if (
      typeof account.providerAccountId !== "string" ||
      typeof profile.sub !== "string" ||
      !account.providerAccountId ||
      account.providerAccountId !== profile.sub
    ) {
      throw new CustomerIdentityConflictError();
    }

    if (
      profile.email_verified !== true ||
      typeof profile.email !== "string" ||
      !profile.email.trim()
    ) {
      throw new CustomerIdentityResolutionError(
        profile.email_verified === true
          ? "invalid_identity"
          : "unverified_email",
      );
    }

    token.customerUserId = await input.resolveIdentity({
      displayName:
        typeof profile.name === "string" && profile.name.trim()
          ? profile.name.trim()
          : null,
      email: profile.email,
      emailVerified: true,
      provider: CUSTOMER_IDENTITY_PROVIDER,
      providerAccountId: account.providerAccountId,
    });
    token.providerUserId = profile.sub;
    token.googleEmailVerified = true;
  }

  return preserveLegacyStaffIdentity(token);
}

export function applyCustomerIdentityToSession<Session extends SessionShape>(
  session: Session,
  token: JwtTokenShape,
): Session & SessionShape {
  if (session.user) {
    if (
      typeof token.customerUserId === "string" &&
      token.customerUserId.length > 0
    ) {
      session.user.id = token.customerUserId;
    } else {
      delete session.user.id;
    }
  }

  return session;
}

function preserveLegacyStaffIdentity<Token extends JwtTokenShape>(
  token: Token,
): Token {
  if (!token.providerUserId && typeof token.sub === "string") {
    token.providerUserId = token.sub;
  }

  return token;
}
