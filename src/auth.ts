import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

interface GoogleIdentityProfile {
  email?: unknown;
  email_verified?: unknown;
  sub?: unknown;
}

export const { auth, handlers, signIn, signOut } = NextAuth({
  callbacks: {
    async jwt({ account, profile, token }) {
      if (account?.provider === "google") {
        const googleProfile = profile as GoogleIdentityProfile | undefined;

        if (typeof googleProfile?.sub === "string") {
          token.providerUserId = googleProfile.sub;
        }

        token.googleEmailVerified = googleProfile?.email_verified === true;
        token.adminAuthenticatedAt = Math.floor(Date.now() / 1000);
      }

      if (!token.providerUserId && typeof token.sub === "string") {
        token.providerUserId = token.sub;
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.providerUserId =
          typeof token.providerUserId === "string" ? token.providerUserId : "";
        session.user.isEmailVerified = token.googleEmailVerified === true;
        session.user.authenticatedAt =
          typeof token.adminAuthenticatedAt === "number"
            ? token.adminAuthenticatedAt
            : 0;
      }

      return session;
    },
    async signIn({ account, profile }) {
      if (account?.provider !== "google") {
        return false;
      }

      const googleProfile = profile as GoogleIdentityProfile | undefined;

      return (
        googleProfile?.email_verified === true &&
        typeof googleProfile.email === "string" &&
        googleProfile.email.trim().length > 0 &&
        typeof googleProfile.sub === "string" &&
        googleProfile.sub.length > 0
      );
    },
  },
  pages: {
    error: "/admin/sign-in",
    signIn: "/admin/sign-in",
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
