// Explicit owned empty original catalog; no provider/SQL credentials or network.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const [moduleInput, repositoryInput, outputInput] = process.argv.slice(2);
if (!moduleInput || !repositoryInput || !outputInput) throw new Error("THREE_EXPLICIT_PATHS_REQUIRED");
const modulePath = resolve(moduleInput), repository = resolve(repositoryInput), output = resolve(outputInput);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const moduleSha256 = hash(readFileSync(modulePath));
const source = await import(pathToFileURL(modulePath).href);
const sourceCommit = "b99d4f346696f897fa6a6729dfcc52d6503fe8d6";
const requirements = source.verifiedSourceRequirements(repository, sourceCommit);
const surfaceSha256 = source.historicalSourceSha256({ fixture: "owned-empty-resend-surface", sourceCommit });
const configurationRecordSha256 = source.historicalSourceSha256({ fixture: "owned-empty-original-configuration", sourceCommit });
const keyCatalog = [], keyCatalogSha256 = source.historicalSourceSha256(keyCatalog);
const provenance = { sourceCommit, surfaceSha256, configurationRecordSha256, kind: "deployment",
  immutableReference: "owned-fixture:resend-empty-original", entrypoint: null, keyCatalogSha256 };
const binding = { sourceCommit, surfaceSha256, configurationRecordSha256, sourceConfiguration: {
  kind: provenance.kind, immutableReference: provenance.immutableReference, entrypoint: null,
  keyCatalogSha256, provenanceSha256: source.historicalSourceSha256(provenance), databaseRoles: [] } };
const original = { sourceCommit, configurationRecordSha256, provenance, keyCatalog, environment: {} };
const prepared = source.prepareHistoricalSourceOriginalConfiguration(requirements, binding, original);
if (prepared.configuredSqlKeys.length) throw new Error("OWNED_EMPTY_SQL_CATALOG_REQUIRED");
let checkpoints = 0;
const sql = await source.observeHistoricalSourceSqlCredentials(requirements, { binding,
  originalConfiguration: original, clientsByKey: new Map(), physicalDatabasesByKey: new Map(),
  verifySession: async () => { checkpoints += 1; } });
const context = source.deriveHistoricalSourceCapabilityClosures(requirements, binding, original, sql);
if (hash(readFileSync(modulePath)) !== moduleSha256) throw new Error("SOURCE_MODULE_CHANGED");
const result = { kind: "actual-source-functions-owned-no-capability-context", ownedFixtureOnly: true,
  actualOriginalConfigurationObserved: false, sourceModuleSha256: moduleSha256, checkpoints,
  configuredSqlPeers: 0, providerCalls: 0, sqlCalls: 0,
  requirements: { ...requirements, ...context },
  sourceSqlFacts: sql.facts.map(({ requirementId, disposition }) => ({ requirementId, disposition })) };
writeFileSync(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ sourceModuleSha256: moduleSha256, sourceCommit,
  sourceInventorySha256: requirements.sourceInventorySha256, requirementsSha256: requirements.requirementsSha256,
  sqlRequirements: sql.facts.length, closures: context.capabilityClosures.length, checkpoints,
  ownedFixtureOnly: true, providerCalls: 0, sqlCalls: 0 }));
