import "server-only";
import { createHmac } from "node:crypto";

const clients = {
  identity: "185770842371-d3thak0b2btgb77pngj968nvhpjkqmgf.apps.googleusercontent.com",
  calendar: "185770842371-lg0fktlf96u88pnqjnoom83st75btv4d.apps.googleusercontent.com",
} as const;

export interface FrontendGoogleBindingProbe {
  googleBinding: {
    projectId: "lash-her-staging-20261022";
    projectNumber: "185770842371";
    identity: { clientId: typeof clients.identity; proof: string };
    calendar: { clientId: typeof clients.calendar; proof: string };
  };
}

/** Transient challenge proofs for the protected operator callback. No provider
 * exchange, refresh grant, incoming credential or persistent proof is used. */
export function createFrontendGoogleBindingProbe(dependencies: {
  environment?: () => Record<string, string | undefined>;
} = {}) {
  return async (source: { environment: string; sourceCommit: string }, challenge: string): Promise<FrontendGoogleBindingProbe> => {
    try {
      if (source.environment !== "staging" || !/^[a-f0-9]{40}$/u.test(source.sourceCommit) || !/^[a-f0-9]{64}$/u.test(challenge)) throw new Error();
      const env = (dependencies.environment ?? (() => process.env))();
      if (env.APP_ENV !== "staging" || env.VERCEL_GIT_COMMIT_SHA !== source.sourceCommit ||
        env.AUTH_GOOGLE_ID !== clients.identity || env.GOOGLE_CLIENT_ID !== clients.calendar) throw new Error();
      const identity = env.AUTH_GOOGLE_SECRET, calendar = env.GOOGLE_CLIENT_SECRET;
      const valid = (value: string | undefined): value is string => Boolean(value && value.length >= 16 && value.length <= 8192 && /^[!-~]+$/u.test(value));
      if (!valid(identity) || !valid(calendar) || identity === calendar) throw new Error();
      const proof = (kind: "identity" | "calendar", secret: string) => createHmac("sha256", secret)
        .update(`lash-her:frontend-google-binding:v1:${kind}:${challenge}`, "utf8").digest("hex");
      return { googleBinding: { projectId: "lash-her-staging-20261022", projectNumber: "185770842371",
        identity: { clientId: clients.identity, proof: proof("identity", identity) },
        calendar: { clientId: clients.calendar, proof: proof("calendar", calendar) } } };
    } catch { throw new Error("FRONTEND_GOOGLE_BINDING_PROBE_REFUSED"); }
  };
}

export const runFrontendGoogleBindingProbe = createFrontendGoogleBindingProbe();
