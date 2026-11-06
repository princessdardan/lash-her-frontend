// Exact historical Git/source profiles, not retroactive candidate admission.
// Private original configuration is inspected only inside this module; values
// and credential-derived digests never enter its returned observations/errors.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";

const approved = {
  "b99d4f346696f897fa6a6729dfcc52d6503fe8d6": {"treeOid":"dee14e1844868d2692c013daec66bee229dda7e7","profileSha256":"6d2272e267e4a3ca48ae346f2db13b20183e44d758d0200b17d9b3bbd7513b76"},
  "74ca26736e5834fce639407278b4575bf4d05670": {"treeOid":"b38d32730d01f0fcc86df00fd09302923e64aa6f","profileSha256":"49a2bf6b94b87fd39b54790f34fcb3c5c74d6905a882213f4bebfe559139ceb1"},
  "b5f7e08c5d264b66286062c60691f4d28d924294": {"treeOid":"4f63ed9c0288b410b64a1f41d7cb70c5d5546364","profileSha256":"338e7671b8ee3fba44eced85efdf6002a2bda8b93826ef78da59ffee6a0c1236"},
  "d915619f11e198e6e1ef7cc1d4e9a2d644eb615a": {"treeOid":"6cedd5073b8d82fe730b8e4558bb3cc0b01f5498","profileSha256":"86f29dd13e71f6fe75ab9349e4261121011def1241e9b94a33707bba7f079b11"},
  "03d850c0512eddc0ef11cbac779e255a7b73bd3b": {"treeOid":"a32fd7a72b7d34710870b9b1f11233cd55c1284c","profileSha256":"4bf94daef3a29b7a568482325425f9991d4da028170849015e074d92bf56f04e"},
  "0ed09401726ff5f6f5057018ba7125a498d7180c": {"treeOid":"42f90f43a2fd7a9c1e053bd785d62919ba07064a","profileSha256":"80ca931d9fd40485441da4a3585119541927ef8b357cc6b9b2f6713144a6675c"},
  "13142937adf542e41d0a12807d2503389933f74e": {"treeOid":"aa9ccfc57e3e4e6a385dad83aacde571a822bb52","profileSha256":"3d89e36431c8aa6410bcb2c322b3a1aeb0994265f62a2510681c619355769ef8"},
  "188af7d78123be519a19bfe8505fc4d6060dda41": {"treeOid":"8db61d2e44782476188912fb9bf8d09ae4e7495d","profileSha256":"a8d5d4a2139d885b2a1c3f554c665902e77d84115f8707b7aee27aa3cf333f64"},
  "18feb565b4b1bd8bc3e9658d2eb3de7523594488": {"treeOid":"b92a69e2e279a5404a7911b2829f7827f60d2fcb","profileSha256":"39d0385b01cfbb19daecc5a7b0a23165764010e3d2ce86a0e88e92b20bf79054"},
  "1d8342ab93b6713bebbb3a9caabaa54a246f9957": {"treeOid":"7ee5cdb0ce0eca84f7707e95e687514c5b217482","profileSha256":"48c50a2c9b9870036a102e959dd9c8bf4020805a6d7107f94f067fb8d727b1b3"},
  "2390ff32c4156bf861cbce32406f5e4ad18583ab": {"treeOid":"42b6ff7b5cff1aba69e20981af0880036d77947d","profileSha256":"d85007daaacd3fd30bd1cd8454ea5f35f47dd3761b1ae08639356783b52a2b54"},
  "24a3fd334209177797a128bd67d07fe805d539f5": {"treeOid":"ac5b651650a83af66e227f80911c33a74dfbd3af","profileSha256":"33fe5ec92a273815957f0fff67ddc05eee5c2cd1680cb440a276d30e562fda0c"},
  "26bcdd9a605eb6c07a75e2a7a7b519015b04deb8": {"treeOid":"3df4a3f67d1315df5336d4f345385962629c8662","profileSha256":"b86181c83b64300767ef4f647b7b45db86a270ec55753cb335a830495da23839"},
  "273a9821a097a7a0beeb918e8b1c4c51932f73ab": {"treeOid":"1741d96a9466ccee1c4a9ebb8ff70adae95fe335","profileSha256":"4e3d6d2c42f8aba57e5285d010f5c6dde7d6d59a7bb705a4c0e0df4e9c81e9cc"},
  "45223fec3ee71bf63cfb0e44a94a0a7b3e282ca1": {"treeOid":"eca5b5ead0d026822a68788f9332ae550f6fbfe0","profileSha256":"dbd981bda67eb5da0fcdcfb22e76b855c5f562f06848ecad570b53589a6dd7ee"},
  "669f2978722a431c3f11cd8f68f59dfde9fe3d76": {"treeOid":"40ff8b54aa6e2b8d2a11e0ef79712d5e31713b42","profileSha256":"3864624c31ca71871438ecb8d7e5450e70b2eb5457077c447926f0d16f4bb09b"},
  "6cce23a6e28a6b43ac5043986b421db7a2e80827": {"treeOid":"7b22db3ad93a77b0c840613a737396e0bcdf89dc","profileSha256":"bb76bc3420d5eece36d4d5aa9fff5b1f3a59a1023ede5c59a51ed668b42d000c"},
  "6d5845a8b6d5ff8f27ac7512d72075328233d0ec": {"treeOid":"018682cf10f5bf938b66cd0d885f0b5b0f5a2286","profileSha256":"5ab4c89698d10e4a1577bde91e06d656448dee1a925490f0ecc9984000b8a177"},
  "6e0e3d41bedd8ea672bf1eff6ff4cb107fc368c6": {"treeOid":"31b019df96a5986d06ff32a3d72d53c278ad7b51","profileSha256":"6c5d0a860d2f4e711dc83786a3e32d8616d4faa41c56fa2948534d495e49d2bc"},
  "73beea0db10099c3b45cff6fac5dcd9a31f12762": {"treeOid":"00fbdc67c20fd225f0ed79a64f9d7cf70c73deb5","profileSha256":"9b8cee7886af203b69b78b9d52ba7b146562127d36faf27c9795bbd6ed602ecc"},
  "78c6f7cc92b3e5a2adc0ef60720899db7c902af2": {"treeOid":"04ed775afdb4eccfd9f1cfb99ff31539511dff27","profileSha256":"8d467c50dd1c84c6edbc297eeff68950c28f365d7bddb41b0032e034f89eecd6"},
  "9b899e4e02afe787f25315a5ef1912d4d32d6080": {"treeOid":"39b58c331bcba718354cb4b5cecacc1fe3c63cc9","profileSha256":"ed8f4fc0436229252a3e60f0d65efa9f158aef9b1321aafeecd0020a84fdad28"},
  "a05f38d4d9452be6ee80c9b51d1b2f9188c54242": {"treeOid":"42f90f43a2fd7a9c1e053bd785d62919ba07064a","profileSha256":"b26d4d2acbbe44239c3584a956d82a0ff52fb3baa5742813eadb6300f736fe90"},
  "b1f46feadab04e5e0934f5c63b9333837b48f56c": {"treeOid":"6f3e765ccb66a375f962466585ccd1ea6aefa884","profileSha256":"d32046e16295130e92870facd458deba98ff3b5e0772b6e0d6672e79e1ca3097"},
  "b2ce650791fca81674f10bd4f9dd768d53efd185": {"treeOid":"e05e49fa001204d93f1467736c44602d68311ed6","profileSha256":"4ac0969f86c5d998bbaa53692e7318c061589e130db40fe5150347e5ccbd7943"},
  "c5e61fcd8ef0ac1e055c5f98ffb98bc6857d44e2": {"treeOid":"5d30243bb0b464aba1007a7efb17fcd32a6dbba5","profileSha256":"62e505eb1c2f3e8b27128ac28aae74f9a581977e4819b0125f438d09cda40d87"},
  "d632773365867a979084876426d74f6a584e6f2c": {"treeOid":"5ead75d605c1a1e41951665f00b770e4771c002a","profileSha256":"6e8cfd8d55b80dfb2ec469a4d7cfc9a7a05c3861a9704af0de62185e4a9150eb"},
  "d789070e4c186be67a474ae3851fb6da7f624179": {"treeOid":"ffbf617bd75974ae1d345325e77e0f0ca69fbe5b","profileSha256":"98d5ffdecb45fce72b7178c3cdd4341dddbc03b980e783c6caa92ca061656e7b"},
  "e01ad6b6e6e319d63440f84b836f22594897b1d4": {"treeOid":"6399666aa67c666c52130aec93f2c6be95efbc20","profileSha256":"30d4e5fde7172e68cf8c6767c02060013f11dd65489b0096e46c0024ca034c21"},
  "e4040282b708d632bb4d45a45180905525b4da8a": {"treeOid":"ec01b34a72a3e1d417917a320f2dea239768ba23","profileSha256":"408e6ee9f95b052d8615ab248cc53b677aa112dbf43f6c83c73f4701a669acd8"},
  "e6ee380122131505583a106437542591badf2172": {"treeOid":"59938d0dd865fbd80bd56b9b2dd8a3a322221a52","profileSha256":"6edd2d73164e830703876122c7d72b4a494eee7ca2ea529f5c6b43cd22d9f067"},
  "ea1772b20453a494dcd3ff635066ebd385906f6b": {"treeOid":"87087786f4795b67eb4781efc0c8dc5a1c71c937","profileSha256":"5fc3a862b8fed37e5d1d01de0dbc3fae0714e51081ec297993770ee7bdda0322"},
  "fd08fe169b529f7d9edde3197873136a991ce863": {"treeOid":"96428ec3cb30f98f6809fab459e6172eb043f534","profileSha256":"5d4687e555944fcf951114d6a14c1283fcb34ea202e90033c2b29818ca0d8f8a"},
};
const proofs = new WeakSet(), sqlProofs = new WeakSet(), privateOriginalValues = new WeakMap();
const refusal = () => new Error("FRONTEND_HISTORICAL_SOURCE_REFUSED");
const demand = condition => { if (!condition) throw refusal(); };
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object" ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
export const historicalSourceSha256 = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(ordered(value))).digest("hex");
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const commit = value => typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const codeFile = file => /^(?:src|scripts|ops)\//u.test(file) && /\.(?:[cm]?[jt]sx?|py|sh)$/u.test(file) &&
  !/(?:^|\/)(?:tests|__tests__|__pycache__)(?:\/|$)|\.(?:test|spec)\./u.test(file);
const configurationFile = file => ["package.json", "package-lock.json", "vercel.json", "vercel.mjs", "next.config.ts", "sanity.config.ts", "sanity.cli.ts"].includes(file) || /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(file);

function gitReader(repository) {
  demand(typeof repository === "string" && realpathSync(repository) === repository);
  return (args, input) => execFileSync("git", ["--no-replace-objects", "--no-optional-locks", ...args], {
    cwd: repository, input, maxBuffer: 96_000_000, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1" },
  });
}
function treeRows(git, sourceCommit) {
  return git(["ls-tree", "-rz", "--full-tree", sourceCommit]).toString("utf8").split("\0").filter(Boolean).map(row => {
    const separator = row.indexOf("\t"), [mode, type, blobOid] = row.slice(0, separator).split(" ");
    return { mode, type, blobOid, file: row.slice(separator + 1) };
  });
}
function readBlobs(git, rows) {
  const bytes = git(["cat-file", "--batch"], rows.map(row => row.blobOid + "\n").join("")), result = new Map();
  let offset = 0;
  for (const row of rows) {
    const newline = bytes.indexOf(10, offset); demand(newline >= offset);
    const match = /^([a-f0-9]{40}) blob ([0-9]+)$/u.exec(bytes.subarray(offset, newline).toString("ascii"));
    demand(match && match[1] === row.blobOid);
    const length = Number(match[2]); demand(length <= 8_000_000);
    offset = newline + 1; const body = bytes.subarray(offset, offset + length); demand(body.length === length);
    offset += length; demand(bytes[offset++] === 10); result.set(row.file, body);
  }
  demand(offset === bytes.length); return result;
}

export function verifyHistoricalFrontendSourceProfile(repository, sourceCommit, profile) {
  try {
    demand(commit(sourceCommit) && approved[sourceCommit]);
    demand(profile?.version === 1 && profile.sourceCommit === sourceCommit && historicalSourceSha256(profile) === approved[sourceCommit].profileSha256);
    const git = gitReader(repository);
    demand(git(["cat-file", "-t", sourceCommit]).toString("utf8").trim() === "commit");
    demand(git(["rev-parse", `${sourceCommit}^{tree}`]).toString("utf8").trim() === approved[sourceCommit].treeOid && profile.treeOid === approved[sourceCommit].treeOid);
    const all = treeRows(git, sourceCommit), selected = all.filter(row => codeFile(row.file) || configurationFile(row.file)).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
    demand(selected.length > 0 && selected.length <= 8192 && selected.every(row => row.type === "blob" && ["100644", "100755"].includes(row.mode)));
    demand(JSON.stringify(selected.map(({ file, blobOid }) => ({ file, blobOid }))) === JSON.stringify(profile.inventory.sourceFiles.map(({ file, blobOid }) => ({ file, blobOid }))));
    const blobs = readBlobs(git, selected);
    for (const row of profile.inventory.sourceFiles) demand(historicalSourceSha256(blobs.get(row.file)) === row.sha256);
    demand(historicalSourceSha256(profile.inventory) === profile.sourceInventorySha256);
    for (const family of profile.providerFamilies) for (const annotation of family.annotations) {
      const bytes = blobs.get(annotation.file), source = profile.inventory.sourceFiles.find(row => row.file === annotation.file);
      demand(source && source.blobOid === annotation.blobOid && source.sha256 === annotation.sha256);
      const lines = bytes.toString("utf8").split("\n");
      demand(Number.isInteger(annotation.lineStart) && annotation.lineStart > 0 && Number.isInteger(annotation.lineEnd) && annotation.lineEnd >= annotation.lineStart && annotation.lineEnd <= lines.length);
      demand(historicalSourceSha256(lines.slice(annotation.lineStart - 1, annotation.lineEnd).join("\n")) === annotation.excerptSha256);
    }
    const facts = { version: 1, status: "FRONTEND_HISTORICAL_SOURCE_VERIFIED", sourceCommit, treeOid: profile.treeOid,
      sourceInventorySha256: profile.sourceInventorySha256, entrypoints: profile.inventory.entrypoints,
      sqlCredentialRequirements: profile.sqlCredentialRequirements, providerFamilies: profile.providerFamilies,
      manualCredentialProfiles: profile.manualCredentialProfiles, sdkDependencies: profile.sdkDependencies,
      sourceReviewDisposition: profile.sourceReviewDisposition, sourceAdmission: "not-qualified-by-current-candidate" };
    const result = freeze({ ...facts, requirementsSha256: historicalSourceSha256(facts) }); proofs.add(result); return result;
  } catch { throw refusal(); }
}

export function verifiedSourceRequirements(repository, sourceCommit) {
  try {
    demand(commit(sourceCommit) && approved[sourceCommit]);
    const profile = JSON.parse(readFileSync(new URL(`./profiles/frontend-historical-sources/${sourceCommit}.json`, import.meta.url), "utf8"));
    return verifyHistoricalFrontendSourceProfile(repository, sourceCommit, profile);
  } catch { throw refusal(); }
}

function originalConfiguration(requirements, binding, original) {
  demand(proofs.has(requirements) && binding?.sourceCommit === requirements.sourceCommit && digest(binding.surfaceSha256) && digest(binding.configurationRecordSha256));
  const selected = binding.sourceConfiguration, provenance = original?.provenance;
  demand(selected && original.sourceCommit === binding.sourceCommit && original.configurationRecordSha256 === binding.configurationRecordSha256 && provenance &&
    provenance.surfaceSha256 === binding.surfaceSha256 && provenance.sourceCommit === binding.sourceCommit && provenance.configurationRecordSha256 === binding.configurationRecordSha256 &&
    ["deployment", "direct-caller"].includes(provenance.kind) && provenance.kind === selected.kind && provenance.immutableReference === selected.immutableReference &&
    typeof provenance.immutableReference === "string" && /^[A-Za-z0-9_./:-]{1,512}$/u.test(provenance.immutableReference) &&
    provenance.entrypoint === selected.entrypoint && digest(selected.keyCatalogSha256) && provenance.keyCatalogSha256 === selected.keyCatalogSha256 &&
    historicalSourceSha256(provenance) === selected.provenanceSha256);
  demand(Array.isArray(original.keyCatalog) && original.keyCatalog.every(key => typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,191}$/u.test(key)) &&
    JSON.stringify(original.keyCatalog) === JSON.stringify([...new Set(original.keyCatalog)].sort()) && historicalSourceSha256(original.keyCatalog) === selected.keyCatalogSha256);
  demand(original.environment && typeof original.environment === "object" && !Array.isArray(original.environment) &&
    JSON.stringify(Object.keys(original.environment).sort()) === JSON.stringify(original.keyCatalog) && Object.values(original.environment).every(value => typeof value === "string") &&
    Object.values(Object.getOwnPropertyDescriptors(original.environment)).every(property => "value" in property));
  if (provenance.nonSecretSelectors !== undefined) demand(provenance.nonSecretSelectors && typeof provenance.nonSecretSelectors === "object" &&
    !Array.isArray(provenance.nonSecretSelectors) && Object.keys(provenance.nonSecretSelectors).every(key => key === "APP_ENV") &&
    Object.entries(provenance.nonSecretSelectors).every(([key, value]) => ["local", "staging", "production"].includes(value) && Object.hasOwn(original.environment, key) && original.environment[key] === value));
  if (selected.kind === "deployment") demand(selected.entrypoint === null);
  else demand(requirements.manualCredentialProfiles.includes(selected.entrypoint));
  return { selected, environment: original.environment };
}

export function historicalSourceSqlCredentialQueryPlan(requirements) {
  demand(proofs.has(requirements));
  return freeze({ version: 1, sourceCommit: requirements.sourceCommit, sourceInventorySha256: requirements.sourceInventorySha256,
    credentials: requirements.sqlCredentialRequirements.map(row => ({ requirementId: row.requirementId, key: row.key })),
    identity: `SELECT current_database() AS database,current_user AS username,session_user AS session_username,
      (SELECT oid::text FROM pg_roles WHERE rolname=session_user) AS role_oid,
      current_setting('server_version_num')::int/10000 AS major,current_setting('default_transaction_read_only') AS read_only`,
    markers: `SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND pid=$1
      AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND mode='ExclusiveLock' AND granted
      AND objsubid=1 AND ((classid::bigint << 32) | objid::bigint)=ANY($2::bigint[])` });
}

export function prepareHistoricalSourceOriginalConfiguration(requirements, binding, original) {
  try {
    const { selected, environment } = originalConfiguration(requirements, binding, original);
    const configuredSqlKeys = requirements.sqlCredentialRequirements.filter(row => Object.hasOwn(environment, row.key)).map(row => row.key).sort();
    demand(Array.isArray(selected.databaseRoles) && new Set(selected.databaseRoles.map(row => row.key)).size === selected.databaseRoles.length &&
      JSON.stringify(selected.databaseRoles.map(row => row.key).sort()) === JSON.stringify(configuredSqlKeys) &&
      selected.databaseRoles.every(row => configuredSqlKeys.includes(row.key) && /^[a-z_][a-z0-9_]{0,62}$/u.test(row.name) && /^[1-9][0-9]{0,9}$/u.test(row.oid)));
    return freeze({ version: 1, sourceCommit: requirements.sourceCommit, surfaceSha256: binding.surfaceSha256,
      configurationRecordSha256: binding.configurationRecordSha256, provenanceSha256: selected.provenanceSha256,
      configuredSqlKeys, databaseRoles: selected.databaseRoles.map(row => ({ key: row.key, name: row.name, oid: row.oid })) });
  } catch { throw refusal(); }
}

export async function observeHistoricalSourceSqlCredentials(requirements, input) {
  try {
    const { binding, originalConfiguration: original, clientsByKey, verifySession } = input;
    const { selected, environment: inputEnvironment } = originalConfiguration(requirements, binding, original), plan = historicalSourceSqlCredentialQueryPlan(requirements);
    prepareHistoricalSourceOriginalConfiguration(requirements, binding, original);
    const environment = Object.fromEntries(Object.entries(inputEnvironment));
    demand(clientsByKey instanceof Map && typeof verifySession === "function" &&
      (input.physicalDatabase || input.physicalDatabasesByKey instanceof Map));
    demand(Array.isArray(selected.databaseRoles) && new Set(selected.databaseRoles.map(row => row.key)).size === selected.databaseRoles.length);
    const databaseRolesSha256 = historicalSourceSha256(selected.databaseRoles);
    await verifySession();
    demand(Object.keys(environment).every(key => original.environment[key] === environment[key]));
    const facts = [];
    for (const requirement of plan.credentials) {
      const configured = Object.hasOwn(environment, requirement.key);
      if (!configured) { demand(!clientsByKey.has(requirement.key)); facts.push({ ...requirement, disposition: "absent-from-immutable-original-key-catalog" }); continue; }
      const client = clientsByKey.get(requirement.key), role = selected.databaseRoles.find(row => row.key === requirement.key);
      const database = input.physicalDatabasesByKey?.get(requirement.key) ?? input.physicalDatabase;
      demand(database && typeof database.database === "string" && [16, 18].includes(database.major) && Number.isInteger(database.parentPid) &&
        Array.isArray(database.markers) && database.markers.length === 4 && new Set(database.markers).size === 4 &&
        database.markers.every(value => typeof value === "string" && /^[1-9][0-9]{0,18}$/u.test(value)));
      demand(client && role && /^[a-z_][a-z0-9_]{0,62}$/u.test(role.name) && /^[1-9][0-9]{0,9}$/u.test(role.oid) &&
        client.connection?.stream?.encrypted === true && client.connection.stream.authorized === true);
      const url = new URL(environment[requirement.key]);
      const parameters = client.connectionParameters;
      demand(["postgres:", "postgresql:"].includes(url.protocol) && decodeURIComponent(url.pathname.slice(1)) === database.database && decodeURIComponent(url.username) === role.name && url.password &&
        parameters?.host === url.hostname && parameters.port === Number(url.port || 5432) && parameters.database === database.database && parameters.user === role.name &&
        parameters.password === decodeURIComponent(url.password));
      await verifySession(requirement.key);
      const rows = (await client.query(plan.identity)).rows;
      demand(rows.length === 1 && rows[0].database === database.database && rows[0].username === role.name && rows[0].session_username === role.name &&
        rows[0].role_oid === role.oid && rows[0].major === database.major && rows[0].read_only === "on");
      demand((await client.query(plan.markers, [database.parentPid, database.markers])).rows[0]?.count === 4); await verifySession(requirement.key);
      facts.push({ ...requirement, disposition: "original-credential-bound-to-physical-database", role: { name: role.name, oid: role.oid }, database: database.database, major: database.major });
    }
    const configuredKeys = plan.credentials.filter(row => Object.hasOwn(environment, row.key)).map(row => row.key).sort();
    demand(JSON.stringify([...clientsByKey.keys()].sort()) === JSON.stringify(configuredKeys) &&
      JSON.stringify(selected.databaseRoles.map(row => row.key).sort()) === JSON.stringify(configuredKeys));
    if (input.physicalDatabasesByKey) demand(JSON.stringify([...input.physicalDatabasesByKey.keys()].sort()) === JSON.stringify(configuredKeys));
    await verifySession();
    demand(Object.keys(environment).every(key => original.environment[key] === environment[key]) && historicalSourceSha256(selected.databaseRoles) === databaseRolesSha256);
    const result = freeze({ version: 1, sourceCommit: requirements.sourceCommit, sourceInventorySha256: requirements.sourceInventorySha256,
      requirementsSha256: requirements.requirementsSha256, surfaceSha256: binding.surfaceSha256, configurationRecordSha256: binding.configurationRecordSha256,
      provenanceSha256: selected.provenanceSha256, databaseRolesSha256, facts, evidenceSha256: historicalSourceSha256({ sourceCommit: requirements.sourceCommit,
        surfaceSha256: binding.surfaceSha256, configurationRecordSha256: binding.configurationRecordSha256, provenanceSha256: selected.provenanceSha256, databaseRolesSha256, facts }) });
    sqlProofs.add(result); privateOriginalValues.set(result, environment); return result;
  } catch { throw refusal(); }
}

export function deriveHistoricalSourceCapabilityClosures(requirements, binding, original, sqlEvidence) {
  try {
    const { environment: currentEnvironment, selected } = originalConfiguration(requirements, binding, original);
    demand(sqlProofs.has(sqlEvidence) && sqlEvidence.sourceCommit === requirements.sourceCommit && sqlEvidence.requirementsSha256 === requirements.requirementsSha256 &&
      sqlEvidence.surfaceSha256 === binding.surfaceSha256 && sqlEvidence.configurationRecordSha256 === binding.configurationRecordSha256 && sqlEvidence.provenanceSha256 === selected.provenanceSha256);
    const environment = privateOriginalValues.get(sqlEvidence);
    demand(environment && Object.keys(environment).every(key => currentEnvironment[key] === environment[key]) && historicalSourceSha256(selected.databaseRoles) === sqlEvidence.databaseRolesSha256);
    const capabilityClosures = [];
    for (const family of requirements.providerFamilies) {
      const absent = family.sourceDisposition === "absent-from-verified-source";
      const paths = family.configurationConditions[0]?.requiredCredentialPaths ?? [];
      // A retained key with a masked, empty or invalid value is not absence.
      // Only its omission from the bound original full key catalog qualifies.
      const noCapability = paths.length > 0 && paths.every(path => path.some(key => !Object.hasOwn(environment, key)));
      const sourceConditions = family.configurationConditions[0];
      const executionClosed = sourceConditions?.mutationExecutions && !sourceConditions.mutationExecutions.some(execution =>
        execution.kind === selected.kind && (execution.kind === "deployment" || execution.entrypoint === selected.entrypoint));
      const guarded = sourceConditions?.originalSelectorClosures?.some(condition => condition.kind === selected.kind &&
        original.provenance.nonSecretSelectors?.[condition.key] === condition.equals && environment[condition.key] === condition.equals);
      if (!absent && !noCapability && !executionClosed && !guarded) continue;
      const requirementIds = [...new Set([...requirements.sqlCredentialRequirements, ...family.configurationConditions,
        ...family.sqlIntentRequirements, ...family.untrackedPotentialRequests].map(row => row.requirementId))].sort();
      capabilityClosures.push({ familyId: family.familyId, sourceCommit: requirements.sourceCommit, surfaceSha256: binding.surfaceSha256,
        configurationRecordSha256: binding.configurationRecordSha256, provenanceSha256: selected.provenanceSha256,
        disposition: absent ? "absent-from-verified-source" : "no-capability-observed", requirementIds,
        evidenceIds: [...new Set([requirements.sourceInventorySha256, requirements.requirementsSha256, binding.configurationRecordSha256, selected.provenanceSha256, sqlEvidence.evidenceSha256])].sort() });
    }
    return freeze({ version: 1, sourceCommit: requirements.sourceCommit, treeOid: requirements.treeOid,
      sourceInventorySha256: requirements.sourceInventorySha256, requirementsSha256: requirements.requirementsSha256,
      surfaceSha256: binding.surfaceSha256, configurationRecordSha256: binding.configurationRecordSha256, provenanceSha256: selected.provenanceSha256, capabilityClosures,
      unresolvedFamilyIds: requirements.providerFamilies.filter(family => !capabilityClosures.some(row => row.familyId === family.familyId)).map(row => row.familyId) });
  } catch { throw refusal(); }
}
