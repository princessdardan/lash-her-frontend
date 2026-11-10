import "server-only";
import { request } from "node:https";

export interface FrontendResendBindingProbe {
  resendBinding: { domainId: string; domainName: "mail.staging.lashher.com"; domainStatus: "verified" };
}

/** Uses only this deployment's server credential and a fixed inert provider
 * GET. It never reads a key from a store, sends mail, or exposes key material. */
export function createFrontendResendBindingProbe(dependencies: {
  environment?: () => Record<string, string | undefined>;
  readDomain?: (domainId: string, credential: string) => Promise<unknown>;
} = {}) {
  return async (source: { environment: string; sourceCommit: string }): Promise<FrontendResendBindingProbe> => {
    try {
      const env = (dependencies.environment ?? (() => process.env))();
      const domainId = env.LASH_RELEASE_RESEND_DOMAIN_ID;
      const credential = env.RESEND_API_KEY;
      if (source.environment !== "staging" || env.APP_ENV !== "staging" || source.sourceCommit !== env.VERCEL_GIT_COMMIT_SHA ||
        env.LASH_RELEASE_RESEND_DOMAIN_NAME !== "mail.staging.lashher.com" ||
        !domainId || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(domainId) ||
        !credential || credential.length > 8192 || !/^[!-~]+$/u.test(credential)) throw new Error();
      const value = await (dependencies.readDomain ?? readResendDomain)(domainId, credential);
      if (!value || typeof value !== "object" || (value as Record<string, unknown>).id !== domainId ||
        (value as Record<string, unknown>).name !== "mail.staging.lashher.com" ||
        (value as Record<string, unknown>).status !== "verified") throw new Error();
      return { resendBinding: { domainId, domainName: "mail.staging.lashher.com", domainStatus: "verified" } };
    } catch { throw new Error("FRONTEND_RESEND_BINDING_PROBE_REFUSED"); }
  };
}

export function readResendDomain(domainId: string, credential: string): Promise<unknown> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(domainId) ||
    !credential || credential.length > 8192 || !/^[!-~]+$/u.test(credential)) return Promise.reject(new Error("FRONTEND_RESEND_BINDING_PROBE_REFUSED"));
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error("FRONTEND_RESEND_BINDING_PROBE_REFUSED"));
    const pending = request({ protocol: "https:", hostname: "api.resend.com", port: 443, method: "GET", path: `/domains/${domainId}`,
      rejectUnauthorized: true, headers: { authorization: `Bearer ${credential}`, accept: "application/json" } }, response => {
      if (response.statusCode !== 200 || !response.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        response.resume(); fail(); return;
      }
      const chunks: Buffer[] = []; let count = 0;
      response.on("data", (chunk: Buffer) => { count += chunk.length; if (count > 65_536) { response.destroy(); fail(); } else chunks.push(chunk); });
      response.on("error", fail);
      response.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { fail(); } });
    });
    pending.on("error", fail); pending.setTimeout(5_000, () => { pending.destroy(); fail(); }); pending.end();
  });
}

export const runFrontendResendBindingProbe = createFrontendResendBindingProbe();
