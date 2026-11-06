import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (!process.argv.includes("--write-reviewed-seven-deltas")) throw Error("Explicit --write-reviewed-seven-deltas required");
const root = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/u, "");
const targetCatalog = JSON.parse(readFileSync(new URL("./reviewed-seven-source-targets.json", import.meta.url), "utf8"));
const auditCatalog = JSON.parse(readFileSync(new URL("../2026-11-05-historical-capability-followup/reviewed-six-source-gates.json", import.meta.url), "utf8"));
const candidates = "/private/tmp/lash-her-reviewed-seven-candidates";
const profileDirectory = `${root}/ops/platform/profiles/frontend-historical-sources`;
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object" ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const canonical = value => JSON.stringify(ordered(value));
const hash = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonical(value)).digest("hex");
const same = (left, right) => canonical(left) === canonical(right);
const codepoint = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const byFile = rows => Map.groupBy(rows, row => row.file);
const inventoryGroups = ["configurations", "providerPaths", ...["routes", "manual", "schedules", "deferred", "actions", "inlineActions", "renders", "dynamicExecution", "sql"].map(group => `entrypoints.${group}`)];
const profileFields = ["version", "sdkDependencies", "sourceReviewDisposition", "sqlCredentialRequirements", "manualCredentialProfiles"];
const inventoryFields = ["version", "scope", "parserVersion", "absentConfigurations"];
const sixFamilyIds = new Set(["google.identity", "google.oauth", "google.calendar", "sanity.editorial", "sanity.callbacks", "mux.studio"]);
const load = (directory, commit) => JSON.parse(readFileSync(`${directory}/${commit}.json`, "utf8"));
const groupValue = (profile, group) => group.startsWith("entrypoints.") ? profile.inventory.entrypoints[group.slice(12)] : profile.inventory[group];

function applyFileOperations(baseRows, operations) {
  const rows = new Map(baseRows.map(row => [row.file, row]));
  for (const operation of operations) operation.operation === "delete" ? rows.delete(operation.file) : rows.set(operation.file, structuredClone(operation.target));
  return [...rows.values()].sort((left, right) => codepoint(left.file, right.file));
}
function applyGroupReplacements(baseRows, replacements, targetSourceFiles) {
  const replacement = new Map(replacements.map(item => [item.file, item.targetRecords])), old = byFile(baseRows), result = [];
  for (const source of targetSourceFiles) result.push(...structuredClone(replacement.get(source.file) ?? old.get(source.file) ?? []));
  return result;
}

const profiles = {};
for (const targetDefinition of targetCatalog.targets) {
  const target = load(candidates, targetDefinition.sourceCommit), base = load(profileDirectory, targetDefinition.baseSourceCommit);
  const targetByFile = new Map(target.inventory.sourceFiles.map(row => [row.file, row]));
  const baseByFile = new Map(base.inventory.sourceFiles.map(row => [row.file, row]));
  const files = [...new Set([...targetByFile.keys(), ...baseByFile.keys()])].sort(codepoint);
  const sourceFileOperations = files.filter(file => !same(targetByFile.get(file), baseByFile.get(file))).map(file => ({ file,
    operation: !baseByFile.has(file) ? "add" : !targetByFile.has(file) ? "delete" : "replace",
    base: baseByFile.get(file) ?? null, target: targetByFile.get(file) ?? null }));
  const inventoryFileGroups = [], invariantInventoryGroups = [];
  for (const group of inventoryGroups) {
    const before = groupValue(base, group), after = groupValue(target, group);
    if (same(before, after)) { invariantInventoryGroups.push({ group, sha256: hash(after) }); continue; }
    const old = byFile(before), next = byFile(after), replacements = [];
    for (const file of files) {
      const prior = old.get(file) ?? [], current = next.get(file) ?? [];
      if (!same(prior, current)) replacements.push({ file, baseRecordsSha256: hash(prior), targetRecords: current });
    }
    inventoryFileGroups.push({ group, baseSha256: hash(before), targetSha256: hash(after), replacements });
  }
  const baseAudit = auditCatalog.profiles.find(item => item.sourceCommit === targetDefinition.baseSourceCommit);
  const auditFiles = [...new Set([...baseAudit.files.map(row => row.file), ...targetDefinition.auditExtraFiles])].sort(codepoint);
  const targetAudit = { sourceCommit: targetDefinition.sourceCommit,
    files: auditFiles.map(file => targetByFile.get(file) ?? { file, absent: true }),
    sdkDependencies: baseAudit.sdkDependencies.map(expected => target.sdkDependencies.find(row => row.name === expected.name) ?? expected) };
  const targetAuditSha256 = hash(targetAudit), providerFamilyReplacements = [], invariantProviderFamilies = [], privateSqlReviewHashFamilies = [];
  for (const family of target.providerFamilies) {
    const prior = base.providerFamilies.find(item => item.familyId === family.familyId);
    if (same(prior, family)) { invariantProviderFamilies.push({ familyId: family.familyId, sha256: hash(family) }); continue; }
    const projected = structuredClone(prior);
    if (sixFamilyIds.has(family.familyId) && projected.configurationConditions[0]?.privateSqlPredicate) {
      projected.configurationConditions[0].sourcePredicateReviewSha256 = targetAuditSha256;
      if (same(projected, family)) { privateSqlReviewHashFamilies.push({ familyId: family.familyId, baseFamilySha256: hash(prior) }); continue; }
    }
    providerFamilyReplacements.push({ familyId: family.familyId, baseSha256: hash(prior), target: family });
  }
  const invariantProfileFields = [], profileFieldReplacements = [];
  for (const field of profileFields) same(base[field], target[field]) ? invariantProfileFields.push({ field, sha256: hash(target[field]) }) :
    profileFieldReplacements.push({ field, baseSha256: hash(base[field]), target: target[field] });
  const delta = { version: 1, format: "frontend-historical-reviewed-profile-delta-v1",
    base: { sourceCommit: targetDefinition.baseSourceCommit, treeOid: base.treeOid, profileSha256: hash(base) },
    target: { sourceCommit: targetDefinition.sourceCommit, treeOid: target.treeOid, profileSha256: hash(target), sourceInventorySha256: target.sourceInventorySha256 },
    invariantProfileFields, profileFieldReplacements,
    invariantInventoryFields: inventoryFields.filter(field => same(base.inventory[field], target.inventory[field])).map(field => ({ field, sha256: hash(target.inventory[field]) })),
    inventoryFieldReplacements: inventoryFields.filter(field => !same(base.inventory[field], target.inventory[field])).map(field => ({ field, baseSha256: hash(base.inventory[field]), target: target.inventory[field] })),
    sourceFileOperations, inventoryFileGroups, invariantInventoryGroups, privateSqlReviewHashFamilies,
    providerFamilyReplacements, invariantProviderFamilies,
    sixFamilyAudit: { baseSourceCommit: baseAudit.sourceCommit, baseSha256: hash(baseAudit), target: targetAudit, targetSha256: targetAuditSha256 } };

  const result = structuredClone(base); result.sourceCommit = targetDefinition.sourceCommit; result.treeOid = target.treeOid;
  result.inventory.sourceCommit = targetDefinition.sourceCommit; result.inventory.treeOid = target.treeOid;
  for (const change of delta.inventoryFieldReplacements) result.inventory[change.field] = structuredClone(change.target);
  result.inventory.sourceFiles = applyFileOperations(result.inventory.sourceFiles, sourceFileOperations);
  for (const change of inventoryFileGroups) {
    const value = applyGroupReplacements(groupValue(result, change.group), change.replacements, result.inventory.sourceFiles);
    if (change.group.startsWith("entrypoints.")) result.inventory.entrypoints[change.group.slice(12)] = value; else result.inventory[change.group] = value;
  }
  for (const change of profileFieldReplacements) result[change.field] = structuredClone(change.target);
  result.sourceInventorySha256 = target.sourceInventorySha256;
  for (const change of providerFamilyReplacements) result.providerFamilies[result.providerFamilies.findIndex(item => item.familyId === change.familyId)] = structuredClone(change.target);
  for (const change of privateSqlReviewHashFamilies) result.providerFamilies.find(item => item.familyId === change.familyId).configurationConditions[0].sourcePredicateReviewSha256 = targetAuditSha256;
  if (!same(result, target)) throw Error(`Closed delta reconstruction drift: ${targetDefinition.sourceCommit}: ${Object.keys(target).filter(key => !same(result[key], target[key])).join(",")}/${Object.keys(target.inventory).filter(key => !same(result.inventory[key], target.inventory[key])).join(",")}`);
  profiles[targetDefinition.sourceCommit] = delta;
  console.log(JSON.stringify({ sourceCommit: targetDefinition.sourceCommit, baseSourceCommit: targetDefinition.baseSourceCommit,
    profileSha256: hash(target), sourceInventorySha256: target.sourceInventorySha256, deltaSha256: hash(delta) }));
}
const register = { version: 1, format: "frontend-historical-reviewed-delta-register-v1", profiles };
writeFileSync(`${root}/ops/platform/profiles/frontend-historical-source-deltas-v1.json`, `${JSON.stringify(register)}\n`);
