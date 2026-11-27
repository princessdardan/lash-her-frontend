import { createHash } from "node:crypto";
import { resolveApplicationEnvironment } from "../env/application-environment.mjs";

export const P600_HOST = "p600-frontend-db.lashher.com";
export const P600_DATABASE = "lash_her_p600_frontend";
export const P600_RUNTIME = "lash_her_frontend_staging_runtime_p2";
export const P600_RELAY = "wss://api-p600.lashher.com/internal/p6-00/postgres";

export const P600_DATABASE_CA = `-----BEGIN CERTIFICATE-----
MIIBvzCCAWagAwIBAgIURYIhT/PBd51jY3M9/gHT5wK4qAowCgYIKoZIzj0EAwIw
LDEqMCgGA1UEAwwhTGFzaCBIZXIgUDYwMCBTdGFnaW5nIERhdGFiYXNlIENBMB4X
DTI2MTEyNzE5NTEzNFoXDTI4MTEyNjE5NTEzNFowLDEqMCgGA1UEAwwhTGFzaCBI
ZXIgUDYwMCBTdGFnaW5nIERhdGFiYXNlIENBMFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEvM/4UmOnX7Gogy1cwcdaa55RJUSeBnNGi5mgEImHV2bS6e6a+yePzO27
RuEeE01XBANGRhyukZ+TvmT8lKk+RaNmMGQwHQYDVR0OBBYEFFGffHEVzeuthRfo
/rn0nRrie/o5MB8GA1UdIwQYMBaAFFGffHEVzeuthRfo/rn0nRrie/o5MBIGA1Ud
EwEB/wQIMAYBAf8CAQAwDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMCA0cAMEQC
IFoGSrcozc1LSxFi8AJOtT/FBKGBFiC+r4PwiTdoseHwAiBncapJKxI6Xz5jKc9i
de/Ut1L8OB9A0i79T6Z9WXAO8w==
-----END CERTIFICATE-----\n`;

export const P600_TARGET_SHA256 = "3a582062cada9dabdaa09adf7f1aa9621256dc4140e79a36fd429ace7be460f2";

export function p600ProducerSha256(commit) {
  return createHash("sha256").update(["lash-her:p600:runtime:v1", commit, P600_TARGET_SHA256].join("\n")).digest("hex");
}

export function selectsP600Relay(connectionString, env) {
  if (Object.keys(env).some(key => key.startsWith("P600_POSTGRES_RELAY_"))) return true;
  if (!URL.canParse(connectionString)) return false;
  const url = new URL(connectionString);
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { pathname = url.pathname; }
  return [url.hostname, ...url.searchParams.getAll("host")].some(host => host.toLowerCase().replace(/\.$/u, "") === P600_HOST) ||
    pathname === "/" + P600_DATABASE;
}

export function readP600RelayConfig(connectionString, env) {
  try {
    const url = new URL(connectionString);
    const target = JSON.parse(env.FRONTEND_WRITER_ADMISSION_TARGET_JSON ?? "null");
    const commit = env.VERCEL_GIT_COMMIT_SHA;
    if (env.FRONTEND_WRITER_ADMISSION_MODE !== "enforce" || !/^[a-f0-9]{40}$/u.test(commit ?? "") || /^0+$/u.test(commit) ||
      target?.environment !== "staging" || target?.host !== P600_HOST || target?.port !== 5432 ||
      target?.user !== P600_RUNTIME || target?.database !== P600_DATABASE || target?.serverMajor !== 18 ||
      target?.targetSha256 !== P600_TARGET_SHA256 || env.FRONTEND_WRITER_PRODUCER_SHA256 !== p600ProducerSha256(commit)) throw new Error();
    const proof = env.P600_POSTGRES_RELAY_DEPLOYMENT_PROOF;
    if (env.VERCEL !== "1" || env.VERCEL_ENV !== "production" || resolveApplicationEnvironment(env) !== "staging" ||
      env.P600_POSTGRES_RELAY_URL !== P600_RELAY || typeof proof !== "string" || !/^[0-9a-f]{64}$/u.test(proof) ||
      /^0+$/u.test(proof) || Object.keys(env).some(key => /^(P407_|P506_|STAGING_P4_07_|STAGING_P5_06_)/u.test(key)) ||
      !["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== P600_HOST ||
      (url.port && url.port !== "5432") || decodeURIComponent(url.username) !== P600_RUNTIME || !url.password ||
      decodeURIComponent(url.pathname) !== "/" + P600_DATABASE || url.hash ||
      [...url.searchParams].length !== 2 || url.searchParams.get("sslmode") !== "verify-full" ||
      url.searchParams.get("channel_binding") !== "require") throw new Error();
    return {endpoint: P600_RELAY, proof, host: P600_HOST, port: 5432};
  } catch {
    throw new Error("P6-00 PostgreSQL relay configuration refused");
  }
}
