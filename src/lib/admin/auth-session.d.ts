import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & {
      isEmailVerified: boolean;
      providerUserId: string;
      authenticatedAt: number;
      firstOwnerWindowSha256?: string;
      firstOwnerDiscoveryWindowSha256?: string;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    googleEmailVerified?: boolean;
    providerUserId?: string;
    adminAuthenticatedAt?: number;
    firstOwnerWindowSha256?: string;
    firstOwnerDiscoveryWindowSha256?: string;
  }
}

export {};
