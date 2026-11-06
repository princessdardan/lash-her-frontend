// Offline documentation builder. Reads public key names and exact Git profiles;
// performs no credential, provider, SQL, admission or deployment operation.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const output = dirname(fileURLToPath(import.meta.url));
const repository = resolve(output, "../../../..");
const catalogRepository = resolve(process.argv[2] ?? repository);
const partialRepository = resolve(process.argv[3] ?? repository);
const read = file => readFileSync(file);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object" ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const hash = value => sha(JSON.stringify(ordered(value)));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const load = file => JSON.parse(read(file));
const sourceFile = "ops/platform/frontend-historical-source.mjs";
assert.equal(sha(read(join(repository, sourceFile))), "2499451470e086b68c495970f9c696862b63b3dd297589f435eecd6320309655");
const source = await import(pathToFileURL(join(repository, sourceFile)));
const partialCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: partialRepository, encoding: "utf8" }).trim();
assert.equal(partialCommit, "4f18b80aee84f0c67b005ce749cf18506fbdedea");
const partialBytes = read(join(partialRepository, sourceFile));
assert.equal(sha(partialBytes), sha(execFileSync("git", ["show", `${partialCommit}:${sourceFile}`], { cwd: partialRepository })));
const partial = await import(pathToFileURL(join(partialRepository, sourceFile)));
assert.equal(typeof partial.historicalSourceOriginalValueKeys, "function");
const directory = "docs/api-integration/baselines/2026-11-06-vercel-deployment-key-catalogs";
const observationsPath = join(catalogRepository, directory, "observations.json");
const setsPath = join(catalogRepository, directory, "key-name-sets.json");
const priorFile = "docs/api-integration/baselines/2026-11-05-p2-historical-project-discovery/retained-projects.json";
const observations = load(observationsPath), sets = load(setsPath).sets, prior = load(join(catalogRepository, priorFile));
assert.equal(observations.observations.length, 81);
assert.equal(Object.keys(sets).length, 31);
for (const [digest, keys] of Object.entries(sets)) {
  assert.deepEqual(keys, [...new Set(keys)].sort());
  assert(keys.every(key => /^[A-Za-z_][A-Za-z0-9_]{0,191}$/u.test(key)));
  assert.equal(hash(keys), digest);
}
const priorRows = new Map([prior.selectedStaging, prior.productionProject].flatMap(project => project.deployments.map(row =>
  [project.projectId + ":" + row.deploymentId, row])));
const profileDirectory = join(repository, "ops/platform/profiles/frontend-historical-sources");
const profiles = new Map(), policies = {}, profileRows = [];
for (const file of readdirSync(profileDirectory).filter(file => /^[a-f0-9]{40}\.json$/u.test(file)).sort()) {
  const commit = file.slice(0, 40), req = source.verifiedSourceRequirements(repository, commit);
  const candidateReq = partial.verifiedSourceRequirements(partialRepository, commit);
  assert.equal(req.requirementsSha256, candidateReq.requirementsSha256);
  const policy = { sqlCredentialKeys: req.sqlCredentialRequirements.map(row => row.key).sort(),
    sourceReviewDisposition: Object.fromEntries(["kind", "credentialPathReuseProviders", "unknownCapabilityProviders"].map(key => [key, req.sourceReviewDisposition[key]])),
    families: req.providerFamilies.map(family => ({ familyId: family.familyId, sourceDisposition: family.sourceDisposition,
      conditions: family.configurationConditions.map(condition => Object.fromEntries(["requiredCredentialPaths", "mutationExecutions", "originalSelectorClosures", "privateSqlPredicate"]
        .filter(key => condition[key] !== undefined).map(key => [key, condition[key]]))) })).sort((a, b) => compare(a.familyId, b.familyId)) };
  const id = hash(policy); policies[id] = policy;
  profiles.set(commit, { req, candidateReq, policy, id });
  profileRows.push({ sourceCommit: commit, treeOid: req.treeOid, profileSha256: sha(read(join(profileDirectory, file))),
    sourceInventorySha256: req.sourceInventorySha256, requirementsSha256: req.requirementsSha256, familyPolicySetSha256: id });
}
assert.equal(profiles.size, 33);

const authKeys = ["AUTH_SECRET", "NEXTAUTH_SECRET", "AUTH_SECRET_1", "AUTH_SECRET_2", "AUTH_SECRET_3"];
const kvKeys = ["KV_REST_API_URL", "KV_REST_API_TOKEN"];
const calendarKeys = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "BOOKING_ADMIN_SETUP_SECRET", ...kvKeys];
const categories = ["source-absent", "credential-path-blocked-by-fullcatalog", "catalog-possible-value-or-selector-needed", "unknownsource"];
function classify(profile, keys) {
  const present = new Set(keys), absent = key => !present.has(key), allSqlAbsent = profile.policy.sqlCredentialKeys.every(absent);
  const storesAbsent = allSqlAbsent && kvKeys.every(absent), authBlocked = authKeys.every(absent), clientBlocked = calendarKeys.some(absent);
  const groups = Object.fromEntries(categories.map(category => [category, []])), reasons = {}, external = [];
  const reason = (id, familyId, details = {}) => {
    const key = hash({ id, ...details }); reasons[key] ??= { reason: id, ...details, familyIds: [] }; reasons[key].familyIds.push(familyId);
  };
  for (const family of profile.req.providerFamilies) {
    assert(family.configurationConditions.length <= 1);
    const condition = family.configurationConditions[0], paths = condition?.requiredCredentialPaths ?? [];
    let category = "catalog-possible-value-or-selector-needed", why = "retained-required-keys-need-original-binding-and-effects";
    let details = {};
    if (family.sourceDisposition === "absent-from-verified-source") { category = "source-absent"; why = "family-absent-from-exact-source"; }
    else if (condition?.mutationExecutions && !condition.mutationExecutions.some(row => row.kind === "deployment")) {
      category = "source-absent"; why = "mutation-entrypoints-are-direct-callers-not-this-deployment";
    } else if (paths.length && paths.every(path => path.some(absent))) {
      category = "credential-path-blocked-by-fullcatalog"; why = "every-reviewed-required-path-has-an-absent-key";
      details = { missingKeys: [...new Set(paths.flat().filter(absent))].sort() };
    } else {
      const predicate = condition?.privateSqlPredicate;
      const predicateBlocked = predicate === "google-auth-signing-absence-v1" ? authBlocked && storesAbsent :
        predicate === "google-oauth-all-alternate-paths-v1" ? authBlocked && storesAbsent && clientBlocked :
          predicate === "google-calendar-all-alternate-paths-v1" ? storesAbsent && clientBlocked :
            predicate === "sanity-signed-private-sql-ingress-v1" ? absent("SANITY_WEBHOOK_SECRET") :
              predicate === "sanity-editorial-private-sql-scope-v1" ? allSqlAbsent || absent("SANITY_WEBHOOK_SECRET") : false;
      if (predicate === "mux-public-editorial-private-sql-scope-v1") {
        category = "source-absent"; why = "audited-mux-studio-has-no-frontend-private-sql-effect";
      } else if (predicateBlocked) {
        category = "credential-path-blocked-by-fullcatalog"; why = "exact-reviewed-private-sql-key-absence-predicate"; details = { predicate };
      } else if (!paths.length && !predicate) why = "verified-source-does-not-authorize-reusing-credential-path-predicates";
      else if (condition?.originalSelectorClosures?.length) why = "original-APP_ENV-selector-is-needed-not-project-or-target-name";
      else if (predicate) { why = "private-sql-signing-client-or-alternate-store-path-remains-possible"; details = { predicate }; }
    }
    groups[category].push(family.familyId); reason(why, family.familyId, details);
    if (family.sourceDisposition === "reachable" && ["sanity.editorial", "mux.studio"].includes(family.familyId)) external.push(family.familyId);
  }
  for (const list of Object.values(groups)) list.sort();
  assert.deepEqual(Object.values(groups).flat().sort(), profile.req.providerFamilies.map(row => row.familyId).sort());
  for (const item of Object.values(reasons)) item.familyIds.sort();
  return { scope: "deployment-frontend-private-sql-and-protected-continuations-only", classifications: groups,
    reasons: Object.values(reasons), externalEditorialCapabilityUnresolvedFamilyIds: external.sort(),
    catalogContext: { presentSqlKeys: profile.policy.sqlCredentialKeys.filter(key => present.has(key)),
      presentKvCredentialKeys: kvKeys.filter(key => present.has(key)), presentAuthSigningKeys: authKeys.filter(key => present.has(key)),
      sanitySigningKeyPresent: present.has("SANITY_WEBHOOK_SECRET"), APP_ENVKeyPresent: present.has("APP_ENV") } };
}
const credentialBindings = ["squareRetiredToken", "resendRetiredToken", "chitchatsRetiredToken", "googleIdentityRetiredSecret", "googleCalendarRetiredSecret"];
function sizing(profile, row, keys, staged, withProviders) {
  // Fixture-only argument scaffolding sizes the pure key-name selector. These
  // synthetic digests/provenance are not original configuration observations.
  const surfaceSha256 = hash({ kind: "offline-value-key-sizing-fixture", deploymentId: row.deploymentId });
  const configurationRecordSha256 = hash({ kind: "not-an-original-configuration-receipt", deploymentId: row.deploymentId });
  const provenance = { surfaceSha256, sourceCommit: profile.req.sourceCommit, configurationRecordSha256,
    kind: "deployment", immutableReference: row.deploymentId, entrypoint: null, keyCatalogSha256: hash(keys),
    ...(staged && keys.includes("APP_ENV") ? { nonSecretSelectors: { APP_ENV: "staging" } } : {}) };
  const binding = { surfaceSha256, sourceCommit: profile.req.sourceCommit, configurationRecordSha256,
    sourceConfiguration: { ...provenance, provenanceSha256: hash(provenance), databaseRoles: [] },
    providerCredentials: withProviders ? credentialBindings.map(runtimeKey => ({ runtimeKey })) : [] };
  return partial.historicalSourceOriginalValueKeys(profile.candidateReq, binding,
    { sourceCommit: profile.req.sourceCommit, configurationRecordSha256, keyCatalog: keys, provenance });
}
const applicabilitySets = {}, surfaces = [], seen = new Set(), represented = new Set();
for (const row of observations.observations) {
  const identity = row.projectId + ":" + row.deploymentId;
  assert(!seen.has(identity)); seen.add(identity);
  const previous = priorRows.get(identity); assert(previous);
  assert.equal(row.providerTarget, previous.target);
  const catalog = row.catalogObservation, req = catalog && profiles.get(catalog.sourceCommit);
  const surface = { projectId: row.projectId, deploymentId: row.deploymentId, providerTarget: row.providerTarget,
    priorState: previous.state, priorStateObservedAt: prior.observedAt, createdAt: previous.created,
    createdAtUtc: new Date(previous.created).toISOString(), sourceCommit: catalog?.sourceCommit ?? null,
    sourceStatus: !catalog ? "unknown-authoritative-source" : req ? "verified-profile" : "unregistered-source",
    originalValuesObserved: false, physicalSqlBindingVerified: false, providerBindingsVerified: false, runtimeClosureProduced: false };
  if (catalog) {
    assert.equal(catalog.createdAt, previous.created); assert.equal(catalog.sourceCommit, previous.sourceCommit);
    assert.equal(catalog.projectId, row.projectId); assert.equal(catalog.deploymentId, row.deploymentId);
    assert.equal(hash(catalog.provenance), catalog.provenanceSha256);
    for (const [name, ref] of Object.entries(row.keyCatalogReferences)) { assert(sets[ref]); assert.equal(catalog.provenance[name + "Sha256"], ref); }
    const keys = sets[row.keyCatalogReferences.keyCatalog];
    Object.assign(surface, { keyCatalogSha256: catalog.keyCatalogSha256, provenanceSha256: catalog.provenanceSha256,
      catalogObservedAt: catalog.observedAt, unionKeyCount: keys.length });
    if (req) {
      represented.add(catalog.sourceCommit);
      const facts = classify(req, keys);
      facts.candidateValueProjection = { status: "unintegrated-candidate-interface-not-live-provenance",
        storePeerKeys: sizing(req, row, keys, false, false), allSupportedProviderBindingsNoSelectorKeys: sizing(req, row, keys, false, true),
        upperBoundIfOriginalStagingSelectorAndAllSupportedBindingsAreVerified: sizing(req, row, keys, true, true) };
      const key = hash(facts); applicabilitySets[key] = facts; surface.applicabilitySetSha256 = key;
      surface.familyPolicySetSha256 = req.id;
      surface.maximumCandidateValueKeys = facts.candidateValueProjection.upperBoundIfOriginalStagingSelectorAndAllSupportedBindingsAreVerified.length;
    } else { surface.classification = "unknownsource"; surface.maximumCandidateValueKeys = null; }
  } else { surface.classification = "unknownsource"; surface.maximumCandidateValueKeys = null; }
  surfaces.push(surface);
}
assert.equal(seen.size, priorRows.size); assert.equal(represented.size, 33);
const sorted = surfaces.sort((a, b) => compare(a.projectId + a.deploymentId, b.projectId + b.deploymentId));
const familyCounts = {};
for (const surface of sorted.filter(row => row.applicabilitySetSha256)) {
  for (const [category, families] of Object.entries(applicabilitySets[surface.applicabilitySetSha256].classifications)) {
    for (const familyId of families) { familyCounts[familyId] ??= Object.fromEntries(categories.map(value => [value, 0])); familyCounts[familyId][category]++; }
  }
}
const summary = { retainedSurfaces: sorted.length, sourceBoundCatalogs: sorted.filter(row => row.keyCatalogSha256).length,
  verifiedSourceSurfaces: sorted.filter(row => row.sourceStatus === "verified-profile").length,
  unregisteredSourceSurfaces: sorted.filter(row => row.sourceStatus === "unregistered-source").length,
  missingSourceSurfaces: sorted.filter(row => row.sourceStatus === "unknown-authoritative-source").length,
  actualSourceCommits: new Set(sorted.map(row => row.sourceCommit).filter(Boolean)).size,
  verifiedSourceCommits: represented.size,
  maximumCandidateSelectedValueKeysOnVerifiedSources: Math.max(...sorted.map(row => row.maximumCandidateValueKeys ?? 0)),
  familyCountsOnVerifiedSources: familyCounts };
assert.deepEqual([summary.sourceBoundCatalogs, summary.verifiedSourceSurfaces, summary.unregisteredSourceSurfaces, summary.missingSourceSurfaces], [76, 59, 17, 5]);
assert.equal(summary.actualSourceCommits, 47);
assert.equal(new Set(sorted.filter(row => row.sourceStatus === "unregistered-source").map(row => row.sourceCommit)).size, 14);
assert.equal(summary.maximumCandidateSelectedValueKeysOnVerifiedSources, 17);
assert.equal(sorted.find(row => row.deploymentId === "dpl_Bqc171V1RouKNkjcrnVtWB1imwKH").maximumCandidateValueKeys, 14);
for (const id of ["contacts", "workflows", "tasks", "opportunities", "conversations", "messages", "webhooks", "oauth"])
  assert.equal(familyCounts["highlevel." + id]["credential-path-blocked-by-fullcatalog"], 24);
for (const id of ["drafts", "postage", "refunds", "tracking"])
  assert.equal(familyCounts["chitchats." + id]["credential-path-blocked-by-fullcatalog"], 15);
const result = { version: 1, status: "OFFLINE_CATALOG_APPLICABILITY_ONLY", scope: "all-81-retained-surfaces-no-mutation-authorization",
  inputs: { catalogs: { file: directory + "/observations.json", sha256: sha(read(observationsPath)) },
    keySets: { file: directory + "/key-name-sets.json", sha256: sha(read(setsPath)) },
    priorStates: { file: priorFile, sha256: sha(read(join(catalogRepository, priorFile))) },
    frozenSourceModule: { file: sourceFile, sha256: sha(read(join(repository, sourceFile))), requirementsAndProfileVersion: "f41c09ab" },
    candidateValueSelector: { commit: partialCommit, file: sourceFile, sha256: sha(partialBytes),
      status: "candidate-interface-awaiting-independent-integration-clearance" } },
  originalConfigurationProvenanceSupplied: false, privateValuesRead: false, runtimeClosuresProduced: false, controlsPerformed: false,
  limitations: ["Catalog names are not original values, account selections, feature enablement, SQL identity or effects.",
    "No capability/SQL/store observation or runtime closure is produced; projection scaffolding is synthetic sizing only.",
    "Unknown source rows have no exhaustive family inventory or selected-value bound; all81 remain in scope.",
    "Source-absent is scoped: family absent, direct-caller-only mutation, or audited Mux private-SQL exclusion; external editorial capability remains unresolved.",
    "Production targets are metadata only; project names, null targets and priorERROR states never authorize controls."],
  summary, sourceProfiles: profileRows, familyPolicySets: policies, applicabilitySets, surfaces: sorted };
writeFileSync(join(output, "register.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ ...summary, familyCountsOnVerifiedSources: undefined, bytes: read(join(output, "register.json")).length }));
