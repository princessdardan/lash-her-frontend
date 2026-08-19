import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & {
      isEmailVerified: boolean;
      providerUserId: string;
      authenticatedAt: number;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    googleEmailVerified?: boolean;
    providerUserId?: string;
    adminAuthenticatedAt?: number;
  }
}

export {};
