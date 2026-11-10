import "server-only";
import { request } from "node:https";

export interface FrontendSquareBindingProbe {
  squareBinding: { environment: "sandbox"; locationId: "LE2H76M5V90AM"; merchantId: string; applicationId: string; currency: "CAD"; country: "CA"; locationStatus: "ACTIVE" };
}

/** Uses only this deployment's server credential and a fixed inert provider
 * GET. It never reads a key from a store, charges a payment, or exposes key material. */
export function createFrontendSquareBindingProbe(dependencies: {
  environment?: () => Record<string, string | undefined>;
  readLocation?: (locationId: string, credential: string) => Promise<unknown>;
} = {}) {
  return async (source: { environment: string; sourceCommit: string }): Promise<FrontendSquareBindingProbe> => {
    try {
      const env = (dependencies.environment ?? (() => process.env))();
      const locationId = env.SQUARE_LOCATION_ID;
      const merchantId = env.LASH_RELEASE_SQUARE_MERCHANT_ID;
      const applicationId = env.SQUARE_APPLICATION_ID;
      const credential = env.SQUARE_ACCESS_TOKEN;
      if (source.environment !== "staging" || env.APP_ENV !== "staging" || source.sourceCommit !== env.VERCEL_GIT_COMMIT_SHA ||
        env.SQUARE_ENVIRONMENT !== "sandbox" || locationId !== "LE2H76M5V90AM" ||
        !merchantId || !/^[A-Za-z0-9_-]{8,192}$/u.test(merchantId) ||
        !applicationId || !/^sandbox-sq0idb-[A-Za-z0-9_-]{1,160}$/u.test(applicationId) ||
        !credential || credential.length > 8192 || !/^[!-~]+$/u.test(credential)) throw new Error();
      const raw = await (dependencies.readLocation ?? readSquareLocation)(locationId, credential);
      const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>).location : undefined;
      if (!value || typeof value !== "object" || (value as Record<string, unknown>).id !== locationId ||
        (value as Record<string, unknown>).merchant_id !== merchantId || (value as Record<string, unknown>).currency !== "CAD" ||
        (value as Record<string, unknown>).country !== "CA" || (value as Record<string, unknown>).status !== "ACTIVE") throw new Error();
      return { squareBinding: { environment: "sandbox", locationId, merchantId, applicationId, currency: "CAD", country: "CA", locationStatus: "ACTIVE" } };
    } catch { throw new Error("FRONTEND_SQUARE_BINDING_PROBE_REFUSED"); }
  };
}

export function readSquareLocation(locationId: string, credential: string): Promise<unknown> {
  if (locationId !== "LE2H76M5V90AM" ||
    !credential || credential.length > 8192 || !/^[!-~]+$/u.test(credential)) return Promise.reject(new Error("FRONTEND_SQUARE_BINDING_PROBE_REFUSED"));
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error("FRONTEND_SQUARE_BINDING_PROBE_REFUSED"));
    const pending = request({ protocol: "https:", hostname: "connect.squareupsandbox.com", port: 443, method: "GET", path: `/v2/locations/${locationId}`,
      rejectUnauthorized: true, headers: { authorization: `Bearer ${credential}`, accept: "application/json", "square-version": "2026-05-20" } }, response => {
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

export const runFrontendSquareBindingProbe = createFrontendSquareBindingProbe();
