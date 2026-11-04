import "server-only";

import { withWriterOperationContext } from "@/lib/writer-admission/context";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { runFrontendWriterOperation } from "../../../ops/platform/frontend-admission.mjs";
import {
  resolveWriterAdmissionConfiguration,
  WriterAdmissionError,
  type WriterAdmissionConfiguration,
} from "@/lib/writer-admission/config";

export type WriterOperationKind = "new-work" | "recovery";
export type WriterAdmissionClient = {
  connect(): Promise<unknown>;
  end(): Promise<unknown>;
  on(event: "error", listener: () => void): unknown;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  connection?: { stream?: { encrypted?: boolean; authorized?: boolean } };
};
export type WriterAdmissionRunner = <T>(kind: WriterOperationKind, task: () => Promise<T>,
  options?: { uncertainResult?: (value: T) => boolean }) => Promise<T>;

export function createWriterAdmissionRunner(dependencies: {
  getConfiguration?: () => WriterAdmissionConfiguration | null;
  createClient?: (configuration: WriterAdmissionConfiguration["connection"]) => WriterAdmissionClient;
} = {}): WriterAdmissionRunner {
  const getConfiguration = dependencies.getConfiguration ?? (() => resolveWriterAdmissionConfiguration(process.env));
  const createClient = dependencies.createClient ?? (configuration => new Client(configuration) as unknown as WriterAdmissionClient);
  return async <T>(kind: WriterOperationKind, task: () => Promise<T>, options?: { uncertainResult?: (value: T) => boolean }): Promise<T> => {
    const configuration = getConfiguration();
    if (!configuration) return task();
    if (kind !== "new-work" && kind !== "recovery") throw new WriterAdmissionError("configuration");
    let client: WriterAdmissionClient | undefined, failure = false, connectionLost = false;
    let output: T | undefined, phase: "unavailable" | "outcome" = "unavailable";
    try {
      client = createClient(configuration.connection);
      client.on("error", () => { connectionLost = true; });
      await client.connect();
      if (connectionLost || client.connection?.stream?.encrypted !== true || client.connection.stream.authorized !== true) throw new Error();
      const { target } = configuration;
      const identity = (await client.query(`SELECT current_user AS username,current_database() AS database,
        current_setting('server_version_num')::int/10000 AS major`)).rows[0];
      if (identity?.username !== target.user || identity.database !== target.database || identity.major !== target.serverMajor) throw new Error();
      // Read the current epoch for every request. Closing new work must not
      // strand a recovery-only deployment behind a stale build-time epoch.
      const policies = (await client.query("SELECT * FROM frontend_admission.current_policy($1,$2,$3,$4)",
        [target.environment, target.targetSha256, configuration.producerSha256, configuration.sourceSha])).rows;
      const policy = policies[0];
      if (policies.length !== 1 || typeof policy.epoch !== "string" || !/^[1-9][0-9]{0,17}$/u.test(policy.epoch) ||
        typeof policy.new_work !== "boolean" || typeof policy.recovery !== "boolean" ||
        (kind === "new-work" ? !policy.new_work : !policy.recovery) || connectionLost) throw new Error();
      phase = "outcome";
      output = await runFrontendWriterOperation(client, target, { id: randomUUID(), kind, epoch: policy.epoch,
        producerSha256: configuration.producerSha256, sourceSha: configuration.sourceSha }, async () => {
        if (connectionLost) throw new Error();
        const result = await withWriterOperationContext(task);
        // A 5xx may describe an uncertain provider result. Preserve an unresolved
        // operation even when a domain handler catches its own exception.
        if (connectionLost || options?.uncertainResult?.(result)) throw new Error();
        return result;
      });
      if (connectionLost) throw new Error();
    } catch { failure = true; }
    finally {
      try { await client?.end(); } catch { failure = true; }
      if (connectionLost) failure = true;
    }
    if (failure) throw new WriterAdmissionError(phase);
    return output as T;
  };
}

export const runWriterAdmission = createWriterAdmissionRunner();
