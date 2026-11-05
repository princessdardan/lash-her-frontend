import "server-only";
import { createHash } from "node:crypto";
import { Client } from "pg";
import { readMigrationCatalog } from "../../../ops/platform/frontend-schema.mjs";
import { resolveWriterAdmissionConfiguration, type WriterAdmissionConfiguration } from "./config";
import type { WriterAdmissionClient } from "./runtime";

export const BOOTSTRAP_DISABLED_FEATURES = [
  "INTEGRATION_CUSTOMER_ACCESS_ENABLED", "INTEGRATION_COURSE_READS_ENABLED", "INTEGRATION_CHECKOUT_ENABLED",
  "INTEGRATION_ENTITLEMENT_RECOVERY_ENABLED", "INTEGRATION_COMMUNITY_READS_ENABLED", "INTEGRATION_COMMUNITY_WRITES_ENABLED",
  "INTEGRATION_LEARNING_ROUTES_ENABLED", "CUSTOMER_AUTH_ENABLED", "CUSTOMER_ACCOUNT_LIFECYCLE_ENABLED", "CUSTOMER_ACCOUNT_LIFECYCLE_RECOVERY_ENABLED",
] as const;

export interface FrontendBootstrapProbe {
  admission: { environment: "staging"; targetSha256: string; producerSha256: string; sourceCommit: string; epoch: string; newWork: false; recovery: false };
  schemaCatalogSha256: string;
  featureControls: Record<(typeof BOOTSTRAP_DISABLED_FEATURES)[number], false>;
}

/** Runtime credentials see catalog metadata and their scoped policy function,
 * never the private Drizzle journal or admission tables. This read-only probe
 * neither admits an operation nor changes any rollout or recovery control. */
export function createFrontendBootstrapProbe(dependencies: {
  environment?: () => Record<string, string | undefined>;
  configuration?: () => WriterAdmissionConfiguration | null;
  createClient?: (configuration: WriterAdmissionConfiguration["connection"]) => WriterAdmissionClient;
  readCatalog?: typeof readMigrationCatalog;
} = {}) {
  return async (source: { environment: string; sourceCommit: string }): Promise<FrontendBootstrapProbe> => {
    const environment = dependencies.environment ?? (() => process.env);
    const assertFeatures = () => {
      const values = environment();
      if (BOOTSTRAP_DISABLED_FEATURES.some(name => values[name] !== "false")) throw new Error("FRONTEND_BOOTSTRAP_PROBE_REFUSED");
    };
    assertFeatures();
    const configuration = (dependencies.configuration ?? (() => resolveWriterAdmissionConfiguration(environment())))();
    if (!configuration || configuration.target.environment !== "staging" || source.environment !== "staging" || source.sourceCommit !== configuration.sourceSha) throw new Error("FRONTEND_BOOTSTRAP_PROBE_REFUSED");
    const client = (dependencies.createClient ?? (options => new Client(options) as unknown as WriterAdmissionClient))(configuration.connection);
    let lost = false, begun = false;
    client.on("error", () => { lost = true; });
    const verify = async () => {
      if (lost || client.connection?.stream?.encrypted !== true || client.connection.stream.authorized !== true) throw new Error("FRONTEND_BOOTSTRAP_PROBE_REFUSED");
      const [row] = (await client.query(`SELECT current_user AS username,current_database() AS database,
        current_setting('server_version_num')::int/10000 AS major,current_setting('transaction_read_only') AS read_only,
        has_schema_privilege(current_user,'drizzle','USAGE') AS journal_access`)).rows;
      if (lost || row?.username !== configuration.target.user || row.database !== configuration.target.database || row.major !== configuration.target.serverMajor || row.read_only !== "on" || row.journal_access !== false) throw new Error("FRONTEND_BOOTSTRAP_PROBE_REFUSED");
    };
    try {
      await client.connect();
      if (lost || client.connection?.stream?.encrypted !== true || client.connection.stream.authorized !== true) throw new Error();
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); begun = true;
      await verify();
      const policies = (await client.query("SELECT * FROM frontend_admission.current_policy($1,$2,$3,$4)", [configuration.target.environment, configuration.target.targetSha256, configuration.producerSha256, configuration.sourceSha])).rows;
      const policy = policies[0];
      if (policies.length !== 1 || typeof policy.epoch !== "string" || !/^[1-9][0-9]{0,17}$/u.test(policy.epoch) || policy.new_work !== false || policy.recovery !== false) throw new Error();
      const catalog = await (dependencies.readCatalog ?? readMigrationCatalog)(client);
      assertFeatures(); await verify();
      const result: FrontendBootstrapProbe = {
        admission: { environment: "staging", targetSha256: configuration.target.targetSha256, producerSha256: configuration.producerSha256, sourceCommit: configuration.sourceSha, epoch: policy.epoch, newWork: false, recovery: false },
        schemaCatalogSha256: createHash("sha256").update(JSON.stringify(catalog)).digest("hex"),
        featureControls: Object.fromEntries(BOOTSTRAP_DISABLED_FEATURES.map(name => [name, false])) as FrontendBootstrapProbe["featureControls"],
      };
      await client.query("COMMIT"); begun = false;
      if (lost) throw new Error();
      return result;
    } catch { throw new Error("FRONTEND_BOOTSTRAP_PROBE_REFUSED"); }
    finally {
      if (begun) { try { await client.query("ROLLBACK"); } catch { /* read-only failure never authorizes progress */ } }
      try { await client.end(); } catch { throw new Error("FRONTEND_BOOTSTRAP_PROBE_REFUSED"); }
    }
  };
}

export const runFrontendBootstrapProbe = createFrontendBootstrapProbe();
