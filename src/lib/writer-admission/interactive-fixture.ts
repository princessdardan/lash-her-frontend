import { EventEmitter } from "node:events";
import { createWriterAdmissionRunner } from "./runtime";

// In-memory protocol peer only. This does not qualify owned-database admission.
export function interactiveAdmissionFixture() {
  const state = { open: true, uncertain: false, finished: false };
  const events: string[] = [];
  const client = Object.assign(new EventEmitter(), {
    connection: { stream: { encrypted: true, authorized: true } },
    async connect() {},
    async end() {},
    async query(sql: string, values?: unknown[]) {
      if (sql.startsWith("SELECT current_user"))
        return {
          rows: [{ username: "owned_runtime", database: "owned", major: 18 }],
        };
      if (sql.includes("current_policy"))
        return {
          rows: [{ epoch: "1", new_work: state.open, recovery: state.open }],
        };
      if (sql.includes("begin_operation")) events.push("admitted");
      if (sql.includes("finish_operation")) {
        events.push("settled");
        state.finished = true;
        state.uncertain = values?.[1] === "uncertain";
      }
      return { rows: [] };
    },
  });
  const run = createWriterAdmissionRunner({
    getConfiguration: () => ({
      target: {
        environment: "staging",
        host: "owned.invalid",
        port: 5432,
        database: "owned",
        user: "owned_runtime",
        serverMajor: 18,
        targetSha256: "a".repeat(64),
      },
      sourceSha: "b".repeat(40),
      producerSha256: "c".repeat(64),
      connection: {
        host: "owned.invalid",
        port: 5432,
        database: "owned",
        user: "owned_runtime",
        password: "fixture",
        ssl: { rejectUnauthorized: true },
        enableChannelBinding: true,
        connectionTimeoutMillis: 1000,
        statement_timeout: 1000,
        lock_timeout: 1000,
        application_name: "owned-fixture",
      },
    }),
    createClient: () => client,
  });
  return { state, events, run };
}
