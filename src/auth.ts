import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

import {
  applyCustomerIdentityToJwt,
  applyCustomerIdentityToSession,
} from "@/lib/customer-identity/auth-callbacks";
import { resolveCustomerIdentity } from "@/lib/customer-identity/service";

interface GoogleIdentityProfile {
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  sub?: unknown;
}

export const { auth, handlers, signIn, signOut } = NextAuth({
  callbacks: {
    async jwt({ account, profile, token }) {
      return applyCustomerIdentityToJwt({
        account,
        profile: profile as GoogleIdentityProfile | undefined,
        resolveIdentity: resolveCustomerIdentity,
        token,
      });
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.providerUserId =
          typeof token.providerUserId === "string" ? token.providerUserId : "";
        session.user.isEmailVerified = token.googleEmailVerified === true;
      }

      return applyCustomerIdentityToSession(session, token);
    },
    async signIn({ account, profile }) {
      if (account?.provider !== "google") {
        return false;
      }

      const googleProfile = profile as GoogleIdentityProfile | undefined;

      return (
        googleProfile?.email_verified === true
        && typeof googleProfile.email === "string"
        && googleProfile.email.trim().length > 0
        && typeof googleProfile.sub === "string"
        && googleProfile.sub.length > 0
      );
    },
  },
  pages: {
    error: "/sign-in",
    signIn: "/sign-in",
  },
  providers: [
    Google({
      authorization: {
        params: {
          scope: "openid profile email",
        },
      },
    }),
  ],
  session: {
    maxAge: 8 * 60 * 60,
    strategy: "jwt",
  },
});
