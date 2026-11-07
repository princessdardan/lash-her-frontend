// Key names only from the owner GET deployment variant. No transport, values,
// historical capability closure, mutation or standalone release certificate.
import { createHash } from "node:crypto";

export const FRONTEND_KEY_CATALOG_TEAM = "team_2Hrn5eMZyZxfAWdmYvyKi9t3";
export const FRONTEND_KEY_CATALOG_PROJECTS = Object.freeze([
  "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM",
  "prj_wvBLVsXzC1XMZ11hSIfBi2bHXsyy",
]);
const FIELDS = ["version", "teamId", "projectId", "deploymentId", "sourceCommit", "createdAt", "observedAt"];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const closed = (value, fields) => object(value) && Object.keys(value).sort().join() === [...fields].sort().join();
const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/u.test(value) && value.length === 40 && !/^0+$/u.test(value);
const ordered = value => Array.isArray(value) ? value.map(ordered) : object(value) ?
  Object.fromEntries(Object.keys(value).sort().map(name => [name, ordered(value[name])])) : value;
const digest = value => createHash("sha256").update(JSON.stringify(ordered(value))).digest("hex");
const demand = value => { if (!value) throw new Error("FRONTEND_DEPLOYMENT_KEY_CATALOG_REFUSED"); };
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

function scope(expected) {
  demand(closed(expected, FIELDS) && expected.version === 1 && expected.teamId === FRONTEND_KEY_CATALOG_TEAM &&
    FRONTEND_KEY_CATALOG_PROJECTS.includes(expected.projectId) && typeof expected.deploymentId === "string" &&
    /^dpl_[A-Za-z0-9]{1,100}$/u.test(expected.deploymentId) && expected.deploymentId.trim() === expected.deploymentId && sha(expected.sourceCommit) &&
    Number.isSafeInteger(expected.createdAt) && expected.createdAt > 0 && typeof expected.observedAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(expected.observedAt) &&
    expected.observedAt.trim() === expected.observedAt && Number.isFinite(Date.parse(expected.observedAt)) && Date.parse(expected.observedAt) >= expected.createdAt);
  demand(new Date(expected.observedAt).toISOString() === (expected.observedAt.includes(".") ? expected.observedAt : expected.observedAt.replace("Z", ".000Z")));
  return expected;
}

function keys(value) {
  demand(Array.isArray(value) && value.length <= 4096 && value.every(name => typeof name === "string" &&
    name.trim() === name && /^[A-Za-z_][A-Za-z0-9_]{0,191}$/u.test(name)) && new Set(value).size === value.length);
  return [...value].sort();
}

export function frontendDeploymentKeyCatalogRequest(expected) {
  scope(expected);
  return freeze({ method: "GET", path: `/v13/deployments/${expected.deploymentId}?teamId=${FRONTEND_KEY_CATALOG_TEAM}` });
}

export function normalizeFrontendDeploymentKeyCatalog(expected, raw) {
  try {
    scope(expected);
    demand(object(raw) && raw.id === expected.deploymentId && raw.ownerId === expected.teamId && raw.projectId === expected.projectId &&
      raw.createdAt === expected.createdAt && object(raw.build) && Object.hasOwn(raw, "env") && Object.hasOwn(raw.build, "env"));
    // These optional public identities cannot contradict the mandatory owner,
    // project and exact Git bindings. Unrelated provider metadata is not copied.
    if (Object.hasOwn(raw, "project")) demand(object(raw.project) && raw.project.id === expected.projectId);
    if (Object.hasOwn(raw, "team")) demand(object(raw.team) && raw.team.id === expected.teamId);
    if (Object.hasOwn(raw, "meta")) demand(object(raw.meta));
    if (Object.hasOwn(raw, "gitSource")) demand(object(raw.gitSource) && ["github", "github-limited", "vercel"].includes(raw.gitSource.type));
    const sourceShaFields = [];
    for (const [name, value] of [["meta.githubCommitSha", raw.meta?.githubCommitSha], ["gitSource.sha", raw.gitSource?.sha]]) {
      const parent = name.startsWith("meta.") ? raw.meta : raw.gitSource;
      if (parent && Object.hasOwn(parent, name.split(".")[1])) {
        demand(sha(value) && value === expected.sourceCommit); sourceShaFields.push(name);
      }
    }
    demand(sourceShaFields.length > 0);
    for (const [parent, name, value] of [[raw.meta, "githubCommitOrg", "princessdardan"], [raw.meta, "githubCommitRepo", "lash-her-frontend"],
      [raw.meta, "githubRepoId", "1114139712"], [raw.gitSource, "repoId", "1114139712"],
      [raw.gitSource, "org", "princessdardan"], [raw.gitSource, "repo", "lash-her-frontend"]]) {
      if (parent && Object.hasOwn(parent, name)) demand(String(parent[name]) === value);
    }
    const runtimeKeyCatalog = keys(raw.env), buildKeyCatalog = keys(raw.build.env);
    const keyCatalog = [...new Set([...runtimeKeyCatalog, ...buildKeyCatalog])].sort(); demand(keyCatalog.length <= 4096);
    const provenance = { kind: "vercel-owner-deployment-get-key-names", method: "GET",
      path: frontendDeploymentKeyCatalogRequest(expected).path, teamId: expected.teamId, projectId: expected.projectId,
      deploymentId: expected.deploymentId, sourceCommit: expected.sourceCommit, createdAt: expected.createdAt, observedAt: expected.observedAt,
      sourceShaFields: sourceShaFields.sort(), runtimeKeyCatalogSha256: digest(runtimeKeyCatalog), buildKeyCatalogSha256: digest(buildKeyCatalog),
      keyCatalogSha256: digest(keyCatalog) };
    return freeze({ version: 1, status: "FRONTEND_DEPLOYMENT_KEY_CATALOG_OBSERVED", provider: "vercel",
      teamId: expected.teamId, projectId: expected.projectId, deploymentId: expected.deploymentId, sourceCommit: expected.sourceCommit,
      createdAt: expected.createdAt, observedAt: expected.observedAt, runtimeKeyCatalog, buildKeyCatalog, keyCatalog,
      keyCatalogSha256: provenance.keyCatalogSha256, provenance, provenanceSha256: digest(provenance),
      catalogOnly: true, originalValuesRecovered: false, configuredCapabilitiesVerified: false,
      noCapabilityClosureProduced: true, sourceAdmissionFenceVerified: false, wholeReleaseAccepted: false });
  } catch { throw new Error("FRONTEND_DEPLOYMENT_KEY_CATALOG_REFUSED"); }
}
