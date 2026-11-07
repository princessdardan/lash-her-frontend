import "server-only";

import { createHmac, randomUUID } from "node:crypto";
import { parseApiClaims } from "@/lib/api-integration/boundary-validation";

export const APPLICATION_TOKEN_PROFILES = {
  "course-learner": {
    schema: "CourseLearnerClaims",
    audience: "lash-her-course-api:learner",
    current: "COURSE_LEARNER_JWT_CURRENT_SECRET",
    previous: "COURSE_LEARNER_JWT_PREVIOUS_SECRET",
  },
  "community-member": {
    schema: "CommunityMemberClaims",
    audience: "lash-her-community-api:member",
    current: "COMMUNITY_MEMBER_JWT_CURRENT_SECRET",
    previous: "COMMUNITY_MEMBER_JWT_PREVIOUS_SECRET",
  },
  "course-admin": {
    schema: "CourseAdminClaims",
    audience: "lash-her-course-api:admin",
    current: "COURSE_ADMIN_JWT_CURRENT_SECRET",
    previous: "COURSE_ADMIN_JWT_PREVIOUS_SECRET",
  },
  "community-admin": {
    schema: "CommunityAdminClaims",
    audience: "lash-her-community-api:admin",
    current: "COMMUNITY_ADMIN_JWT_CURRENT_SECRET",
    previous: "COMMUNITY_ADMIN_JWT_PREVIOUS_SECRET",
  },
} as const;

export type ApplicationTokenProfile = keyof typeof APPLICATION_TOKEN_PROFILES;
export type CourseCapability = "course-editor" | "course-support";
export type ApplicationPrincipal =
  | { profile: "course-learner" | "community-member"; customerId: string }
  | { profile: "course-admin"; adminId: string; capabilities: CourseCapability[] }
  | { profile: "community-admin"; adminId: string; capabilities: ["community-moderator"] };

export class ApplicationTokenError extends Error {
  constructor() {
    super("Integration application token unavailable");
    this.name = "ApplicationTokenError";
  }
}

const SERVICE_KEY_NAMES = [
  "CUSTOMER_AUTH_SECRET", "AUTH_SECRET", "NEXTAUTH_SECRET",
  "RESEND_API_KEY", "SQUARE_ACCESS_TOKEN", "GOOGLE_CLIENT_SECRET",
  "CUSTOMER_AUTH_GOOGLE_CLIENT_SECRET", "CUSTOMER_AUTH_RESEND_API_KEY",
  "CUSTOMER_AUTH_GOOGLE_SECRET", "CUSTOMER_AUTH_RESEND_KEY",
  "INTERNAL_SERVICE_JWT_SECRET", "INTERNAL_SERVICE_JWT_PREVIOUS_SECRET",
  "COURSE_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET", "COURSE_ACCOUNT_LIFECYCLE_JWT_PREVIOUS_SECRET",
  "COMMUNITY_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET", "COMMUNITY_ACCOUNT_LIFECYCLE_JWT_PREVIOUS_SECRET",
] as const;

/** Server-only issuer. Callers supply principals obtained from verified sessions,
 * never browser-submitted customer IDs, staff capabilities or provider IDs. */
export function createApplicationTokenIssuer(dependencies: {
  getEnvironment?: () => Readonly<Record<string, string | undefined>>;
  now?: () => number;
} = {}) {
  const getEnvironment = dependencies.getEnvironment ?? (() => process.env);
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1_000));
  return (principal: ApplicationPrincipal): string => {
    try {
      const profile = Object.hasOwn(APPLICATION_TOKEN_PROFILES, principal?.profile)
        ? APPLICATION_TOKEN_PROFILES[principal.profile] : undefined;
      if (!profile) throw new Error();
      const environment = getEnvironment();
      const key = environment[profile.current];
      if (!key || Buffer.byteLength(key, "utf8") < 32 || key.trim() !== key) throw new Error();
      // Rotation keys remain verifier-only. Refuse any known cross-profile or
      // service/session-key reuse rather than treating an audience as isolation.
      const otherNames = [
        ...Object.values(APPLICATION_TOKEN_PROFILES).flatMap((entry) => [entry.current, entry.previous]),
        ...SERVICE_KEY_NAMES,
      ].filter((name) => name !== profile.current);
      const serviceRotationKeys = environment.INTERNAL_SERVICE_JWT_SECRETS?.split(",").map((value) => value.trim()) ?? [];
      if (otherNames.some((name) => environment[name] === key) || serviceRotationKeys.includes(key)) throw new Error();
      const issuedAt = now();
      const isAdmin = principal.profile === "course-admin" || principal.profile === "community-admin";
      const claims = parseApiClaims(profile.schema, {
        version: 1,
        iss: "lash-her-frontend",
        aud: profile.audience,
        sub: isAdmin ? principal.adminId : principal.customerId,
        iat: issuedAt,
        exp: issuedAt + 300,
        jti: randomUUID(),
        ...(isAdmin ? { capabilities: principal.capabilities } : {}),
      }, issuedAt);
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      const input = `${header}.${payload}`;
      const signature = createHmac("sha256", key).update(input).digest("base64url");
      return `${input}.${signature}`;
    } catch {
      // Validator details, environment values and caller data never escape.
      throw new ApplicationTokenError();
    }
  };
}

export const mintApplicationToken = createApplicationTokenIssuer();
