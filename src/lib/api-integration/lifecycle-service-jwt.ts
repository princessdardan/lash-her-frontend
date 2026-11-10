import "server-only";

import { createHmac, randomUUID } from "node:crypto";

const profiles = {
  course: { audience: "lash-her-course-api:account-lifecycle", current: "COURSE_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET", previous: "COURSE_ACCOUNT_LIFECYCLE_JWT_PREVIOUS_SECRET" },
  community: { audience: "lash-her-community-api:account-lifecycle", current: "COMMUNITY_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET", previous: "COMMUNITY_ACCOUNT_LIFECYCLE_JWT_PREVIOUS_SECRET" },
} as const;
export type LifecycleServiceReceiver = keyof typeof profiles;

export class LifecycleTokenError extends Error {
  constructor() { super("Account lifecycle service token unavailable"); this.name = "LifecycleTokenError"; }
}

export function createLifecycleServiceTokenIssuer(dependencies: { getEnvironment?: () => Readonly<Record<string, string | undefined>>; now?: () => number } = {}) {
  const environment = dependencies.getEnvironment ?? (() => process.env);
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  return (receiver: LifecycleServiceReceiver): string => {
    try {
      if (!Object.hasOwn(profiles, receiver)) throw new Error();
      const profile = profiles[receiver], values = environment();
      const current = values[profile.current], previous = values[profile.previous];
      const validKey = (key: string | undefined): key is string => Boolean(key && key.trim() === key && Buffer.byteLength(key, "utf8") >= 32 && Buffer.byteLength(key, "utf8") <= 4096);
      if (!validKey(current) || previous !== undefined && (!validKey(previous) || previous === current)) throw new Error();
      for (const [name, value] of Object.entries(values)) {
        if (!value || name === profile.current || name === profile.previous || !/(?:SECRET|SECRETS|TOKEN|PASSWORD|KEYS?)(?:_[0-9]+)?$|(?:^|_)DATABASE_URL$/u.test(name)) continue;
        const keys = name.endsWith("SECRETS") || name.endsWith("KEYS") ? value.split(",").map(key => key.trim()) : [value];
        if (keys.includes(current) || previous !== undefined && keys.includes(previous)) throw new Error();
      }
      const issuedAt = now();
      if (!Number.isSafeInteger(issuedAt) || issuedAt < 0 || issuedAt > Number.MAX_SAFE_INTEGER - 300) throw new Error();
      const claims = { iss: "lash-her-frontend", aud: profile.audience, sub: "frontend-account-lifecycle", iat: issuedAt, exp: issuedAt + 300, jti: randomUUID() };
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
      const input = `${header}.${payload}`;
      return `${input}.${createHmac("sha256", current).update(input).digest("base64url")}`;
    } catch { throw new LifecycleTokenError(); }
  };
}

export const mintLifecycleServiceToken = createLifecycleServiceTokenIssuer();
