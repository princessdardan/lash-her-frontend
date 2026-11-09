import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { getAdminOwnerEmails } from "@/lib/env/admin";
import { currentWriterFirstOwner, matchesWriterFirstOwner, writerFirstOwnerWindowSha256 } from "@/lib/writer-admission/context";

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
        const firstOwner = currentWriterFirstOwner();
        delete token.firstOwnerWindowSha256;
        if (firstOwner && googleProfile?.email_verified === true && typeof googleProfile.email === "string" &&
          typeof googleProfile.sub === "string" && matchesWriterFirstOwner(firstOwner, googleProfile.email.trim().toLowerCase(), googleProfile.sub)) {
          token.firstOwnerWindowSha256 = writerFirstOwnerWindowSha256(firstOwner);
        }
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
        if (typeof token.firstOwnerWindowSha256 === "string") {
          session.user.firstOwnerWindowSha256 = token.firstOwnerWindowSha256;
        }
      }

      return session;
    },
    async signIn({ account, profile }) {
      if (account?.provider !== "google") {
        return false;
      }

      const googleProfile = profile as GoogleIdentityProfile | undefined;

      if (googleProfile?.email_verified !== true || typeof googleProfile.email !== "string" ||
        !googleProfile.email.trim() || typeof googleProfile.sub !== "string" || !googleProfile.sub) return false;
      const firstOwner = currentWriterFirstOwner();
      if (!firstOwner) return true;
      const email = googleProfile.email.trim().toLowerCase();
      return getAdminOwnerEmails().has(email) && matchesWriterFirstOwner(firstOwner, email, googleProfile.sub);
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
