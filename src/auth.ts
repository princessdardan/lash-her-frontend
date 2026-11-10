import NextAuth, { type NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import type { NextRequest } from "next/server";
import { getAdminOwnerEmails } from "@/lib/env/admin";
import { getAdminUserStore } from "@/lib/admin/admin-user-store";
import { readSelectedAdminGoogleUser } from "@/lib/admin/auth-service";
import { currentWriterFirstOwner, currentWriterIdentityRotation, markWriterOperationUncertain,
  matchesWriterFirstOwner, writerFirstOwnerWindowSha256 } from "@/lib/writer-admission/context";
import { createGoogleCallbackAdmission } from "@/lib/writer-admission/google-auth-callback";

interface GoogleIdentityProfile {
  email?: unknown;
  email_verified?: unknown;
  sub?: unknown;
}

async function isSelectedRotationAdmin(actorId: string, email: unknown, emailVerified: unknown, providerUserId: unknown) {
  try {
    return (await readSelectedAdminGoogleUser(getAdminUserStore(), { email, emailVerified, providerUserId }, actorId)) !== null;
  } catch {
    markWriterOperationUncertain();
    return false;
  }
}

const googleAuthorization = { params: { scope: "openid profile email" } };
const adminAuthConfig: NextAuthConfig = {
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
      } else {
        const rotation = currentWriterIdentityRotation();
        if (rotation?.actorKind === "admin" &&
          !await isSelectedRotationAdmin(rotation.actorId, token.email, token.googleEmailVerified, token.providerUserId)) return null;
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
        const rotation = currentWriterIdentityRotation();
        if (rotation?.actorKind === "admin") session.user.id = rotation.actorId;
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
      const rotation = currentWriterIdentityRotation();
      if (rotation?.actorKind === "admin") return account.providerAccountId === googleProfile.sub &&
        isSelectedRotationAdmin(rotation.actorId, googleProfile.email, googleProfile.email_verified, googleProfile.sub);
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
  providers: [Google({ authorization: googleAuthorization })],
  session: {
    maxAge: 8 * 60 * 60,
    strategy: "jwt",
  },
};

const { auth, handlers: defaultHandlers, signIn, signOut } = NextAuth(adminAuthConfig);
export { auth, signIn, signOut };

function adminAuthHandlers(request: NextRequest): typeof defaultHandlers {
  const callbackAdmission = createGoogleCallbackAdmission(request.nextUrl.pathname === "/api/auth/callback/google");
  if (!callbackAdmission) return defaultHandlers;
  return NextAuth({
    ...adminAuthConfig,
    providers: [Google({ authorization: googleAuthorization, ...callbackAdmission.providerOptions })],
    logger: {
      error(error) {
        if (callbackAdmission.recordError(error)) console.error("[auth][error] Admin Google callback outcome could not be determined.");
      },
    },
  }).handlers;
}

export const handlers: typeof defaultHandlers = {
  GET: request => adminAuthHandlers(request).GET(request),
  POST: request => adminAuthHandlers(request).POST(request),
};
