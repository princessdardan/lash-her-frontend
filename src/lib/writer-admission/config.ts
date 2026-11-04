import "server-only";
import { resolveApplicationEnvironment } from "@/lib/env/application-environment.mjs";

export class WriterAdmissionError extends Error {
  readonly code: "configuration" | "unavailable" | "outcome";
  constructor(code: "configuration" | "unavailable" | "outcome") {
    super(`Writer admission ${code}`);
    this.name = "WriterAdmissionError";
    this.code = code;
  }
}
export type WriterAdmissionTarget = {
  environment: "staging" | "production";
  host: string;
  port: number;
  database: string;
  user: string;
  serverMajor: 16 | 18;
  targetSha256: string;
};
export type WriterAdmissionConfiguration = {
  target: WriterAdmissionTarget;
  producerSha256: string;
  sourceSha: string;
  connection: {
    host: string; port: number; database: string; user: string; password: string;
    ssl: { rejectUnauthorized: true }; enableChannelBinding: true;
    connectionTimeoutMillis: number; statement_timeout: number; lock_timeout: number;
    application_name: string;
  };
};
const digest = (value: unknown, length: number): value is string =>
  typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value) && !/^0+$/u.test(value);
const name = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/u.test(value);

export function resolveWriterAdmissionConfiguration(
  env: Record<string, string | undefined>,
): WriterAdmissionConfiguration | null {
  if (env.FRONTEND_WRITER_ADMISSION_MODE === undefined || env.FRONTEND_WRITER_ADMISSION_MODE === "off") return null;
  try {
    if (env.FRONTEND_WRITER_ADMISSION_MODE !== "enforce" || env.VERCEL_ENV !== "production" || env.VERCEL_TARGET_ENV !== "production") throw new Error();
    const environment = resolveApplicationEnvironment(env);
    if (environment === "local") throw new Error();
    const value: unknown = JSON.parse(env.FRONTEND_WRITER_ADMISSION_TARGET_JSON ?? "");
    if (!value || typeof value !== "object") throw new Error();
    const target = value as WriterAdmissionTarget;
    if (target.environment !== environment || typeof target.host !== "string" ||
      !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(target.host) || /pooler|pgbouncer/u.test(target.host) ||
      !Number.isInteger(target.port) || target.port < 1 || target.port > 65535 ||
      !name(target.database) || !name(target.user) || ![16, 18].includes(target.serverMajor) ||
      !digest(target.targetSha256, 64) || !digest(env.FRONTEND_WRITER_PRODUCER_SHA256, 64) || !digest(env.VERCEL_GIT_COMMIT_SHA, 40)) throw new Error();
    const url = new URL(env.FRONTEND_WRITER_ADMISSION_DATABASE_URL ?? "");
    if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== target.host ||
      Number(url.port || 5432) !== target.port || decodeURIComponent(url.pathname) !== `/${target.database}` ||
      decodeURIComponent(url.username) !== target.user || !url.password || url.hash ||
      [...url.searchParams].length !== 1 || url.searchParams.get("sslmode") !== "verify-full") throw new Error();
    return {
      target: { environment, host: target.host, port: target.port, database: target.database, user: target.user,
        serverMajor: target.serverMajor, targetSha256: target.targetSha256 },
      producerSha256: env.FRONTEND_WRITER_PRODUCER_SHA256,
      sourceSha: env.VERCEL_GIT_COMMIT_SHA,
      connection: { host: target.host, port: target.port, database: target.database, user: target.user,
        password: decodeURIComponent(url.password), ssl: { rejectUnauthorized: true }, enableChannelBinding: true,
        connectionTimeoutMillis: 5_000, statement_timeout: 10_000, lock_timeout: 1_000,
        application_name: "lash-her-frontend-writer-admission" },
    };
  } catch { throw new WriterAdmissionError("configuration"); }
}
