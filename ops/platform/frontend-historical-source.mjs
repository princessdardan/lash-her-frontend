// Exact historical Git/source profiles, not retroactive candidate admission.
// Private original configuration is inspected only inside this module; values
// and credential-derived digests never enter its returned observations/errors.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { readFileSync, realpathSync } from "node:fs";

const approved = {
  "0678e16109425247047865e4aef0b7393d73dc15": {"treeOid":"018682cf10f5bf938b66cd0d885f0b5b0f5a2286","profileSha256":"b972824c0305e556a190ba06ed894f7f2b6d0334a953bc48495516b2571ed342","sourceProfileCommit":"6d5845a8b6d5ff8f27ac7512d72075328233d0ec"},
  "b99d4f346696f897fa6a6729dfcc52d6503fe8d6": {"treeOid":"dee14e1844868d2692c013daec66bee229dda7e7","profileSha256":"02657aa16c63d5573288ee786dde2d2b4baaf7a231b78e4dd340983a8f1726dd"},
  "74ca26736e5834fce639407278b4575bf4d05670": {"treeOid":"b38d32730d01f0fcc86df00fd09302923e64aa6f","profileSha256":"f2ac8d341f8410eaa8b41d403a04508fc5ead9a70b33eaa098042914e50f525d"},
  "b5f7e08c5d264b66286062c60691f4d28d924294": {"treeOid":"4f63ed9c0288b410b64a1f41d7cb70c5d5546364","profileSha256":"5e9e1fe22ea09eb20d33b4fc4f811fb46ed92596288b9cb42d1598d361f5da23"},
  "d915619f11e198e6e1ef7cc1d4e9a2d644eb615a": {"treeOid":"6cedd5073b8d82fe730b8e4558bb3cc0b01f5498","profileSha256":"75ee05f3b2f11095321c111ff3fd78fa4ea4448d16ca96fe6b54079fc2f0fc24"},
  "03d850c0512eddc0ef11cbac779e255a7b73bd3b": {"treeOid":"a32fd7a72b7d34710870b9b1f11233cd55c1284c","profileSha256":"9efd798186a392c081cac4b42b8dd70e298fcc425fa949913b9599e28ecf40b0"},
  "0ed09401726ff5f6f5057018ba7125a498d7180c": {"treeOid":"42f90f43a2fd7a9c1e053bd785d62919ba07064a","profileSha256":"bc683f02fcf0f7b341860105c84cf4e091a7da6c7fbd02fb4e8ed228182e5a0b"},
  "122ea515aba5042ac3f4b7fa63090963bade899d": {"treeOid":"6f3e765ccb66a375f962466585ccd1ea6aefa884","profileSha256":"0f24a07fca7e2dfc84f0069768a31d7f9415e8bf523b61f29a41132d17c477c0","sourceProfileCommit":"b1f46feadab04e5e0934f5c63b9333837b48f56c"},
  "13142937adf542e41d0a12807d2503389933f74e": {"treeOid":"aa9ccfc57e3e4e6a385dad83aacde571a822bb52","profileSha256":"39dc96aec7b0227b7a8b19ee9822cc47eb00525e5cdebd663f8ec54190f3e46c"},
  "188af7d78123be519a19bfe8505fc4d6060dda41": {"treeOid":"8db61d2e44782476188912fb9bf8d09ae4e7495d","profileSha256":"fe63f88bf6a011d3484c9fc754f7bc5f13e0d2cc83c1a89e9ebfcc69602ec220"},
  "18feb565b4b1bd8bc3e9658d2eb3de7523594488": {"treeOid":"b92a69e2e279a5404a7911b2829f7827f60d2fcb","profileSha256":"eef6289d1ec00968942142eaeb9be733ec5aecf9d893d4811ef7d5d040797b50"},
  "1d8342ab93b6713bebbb3a9caabaa54a246f9957": {"treeOid":"7ee5cdb0ce0eca84f7707e95e687514c5b217482","profileSha256":"4106eb329fc9c67deb7086b018ab6a6c7851ba7eed8e54ea46d219d7b8e8df67"},
  "2390ff32c4156bf861cbce32406f5e4ad18583ab": {"treeOid":"42b6ff7b5cff1aba69e20981af0880036d77947d","profileSha256":"13b4827f063855dedbf959f689b3887e22d5aef28597ac64c05ad577372c87e2"},
  "24a3fd334209177797a128bd67d07fe805d539f5": {"treeOid":"ac5b651650a83af66e227f80911c33a74dfbd3af","profileSha256":"d7da957b29fcea5a7396db87bdfa8efb3ecca36cb690e42b01cabb67cba9c7e4"},
  "26bcdd9a605eb6c07a75e2a7a7b519015b04deb8": {"treeOid":"3df4a3f67d1315df5336d4f345385962629c8662","profileSha256":"5c8f052f5ac22a6ae59a535589177188806f6813054542b11201577eb5730e8b"},
  "273a9821a097a7a0beeb918e8b1c4c51932f73ab": {"treeOid":"1741d96a9466ccee1c4a9ebb8ff70adae95fe335","profileSha256":"5084511674cc27beb86d99c877a462f9f7e9d773945f3ef22b1a3c0558768732"},
  "3e105d4d54d77a7ca0f28607bfc9202107e3259e": {"treeOid":"e05e49fa001204d93f1467736c44602d68311ed6","profileSha256":"9e4cb033b96836645b0421e12bf4c087d068ce624654390ab2d3288cb6a78cd3","sourceProfileCommit":"b2ce650791fca81674f10bd4f9dd768d53efd185"},
  "45223fec3ee71bf63cfb0e44a94a0a7b3e282ca1": {"treeOid":"eca5b5ead0d026822a68788f9332ae550f6fbfe0","profileSha256":"a1f66db63fa3ec92738497ba91ee01012137b2dd8d96835ca227e0bf0d6b6ea2"},
  "5e5c46c42332671945e3a240513194453c477b78": {"treeOid":"7ee5cdb0ce0eca84f7707e95e687514c5b217482","profileSha256":"05f84ac2bd7bc33354d0c38e151529d5afed9814269f4379c709e041f7668f8a","sourceProfileCommit":"1d8342ab93b6713bebbb3a9caabaa54a246f9957"},
  "669f2978722a431c3f11cd8f68f59dfde9fe3d76": {"treeOid":"40ff8b54aa6e2b8d2a11e0ef79712d5e31713b42","profileSha256":"9fea204b5de93a6ccf9b77dfe4e7fcbf81b45f254a6005dc83b38a391c6bb8f4"},
  "6cce23a6e28a6b43ac5043986b421db7a2e80827": {"treeOid":"7b22db3ad93a77b0c840613a737396e0bcdf89dc","profileSha256":"18113ab3c00cb3476374545b1dc974c6c8d59ab8570d415e165e027fb97852dc"},
  "6d5845a8b6d5ff8f27ac7512d72075328233d0ec": {"treeOid":"018682cf10f5bf938b66cd0d885f0b5b0f5a2286","profileSha256":"d80d68495d158463dfeca186e0c72a54d68d9ecc0e81af5a3f5130b57b897e56"},
  "6e0e3d41bedd8ea672bf1eff6ff4cb107fc368c6": {"treeOid":"31b019df96a5986d06ff32a3d72d53c278ad7b51","profileSha256":"c6961028fc84f467735c9e1f0253c41608b1667237e959858b5fb352c34427db"},
  "73beea0db10099c3b45cff6fac5dcd9a31f12762": {"treeOid":"00fbdc67c20fd225f0ed79a64f9d7cf70c73deb5","profileSha256":"b1d49e31881aac65ba51fa5de6de32db676c0d2098f9b18c7dae09763d090f44"},
  "78c6f7cc92b3e5a2adc0ef60720899db7c902af2": {"treeOid":"04ed775afdb4eccfd9f1cfb99ff31539511dff27","profileSha256":"59008f22f803be864dc2be0da9fd1acd0066867a99fc794bc3b2fd63d3f243cf"},
  "85dea97b0deae17cff19e345268bddafeba9fe28": {"treeOid":"aa9ccfc57e3e4e6a385dad83aacde571a822bb52","profileSha256":"5c1c39650e35589f95bdedea22a39ff3023659cbb98bf423986d585483d0c98d","sourceProfileCommit":"13142937adf542e41d0a12807d2503389933f74e"},
  "89d2aba195741c62c56c3de8d8a7d90cdaf2da19": {"treeOid":"1741d96a9466ccee1c4a9ebb8ff70adae95fe335","profileSha256":"af9abd573778c0de9051fd609fb68a2ee3eb330cd66316372db05b0e674e6b32","sourceProfileCommit":"273a9821a097a7a0beeb918e8b1c4c51932f73ab"},
  "9b899e4e02afe787f25315a5ef1912d4d32d6080": {"treeOid":"39b58c331bcba718354cb4b5cecacc1fe3c63cc9","profileSha256":"722c0fa3650873c224737ab75ad7921a2407c94da2adf35e010392099b3b5748"},
  "a05f38d4d9452be6ee80c9b51d1b2f9188c54242": {"treeOid":"42f90f43a2fd7a9c1e053bd785d62919ba07064a","profileSha256":"a1cce58135d6a9c3af18b45297b2e48cfe44f6e60b7b6e1e8dc628e9d2cde1a0"},
  "b1f46feadab04e5e0934f5c63b9333837b48f56c": {"treeOid":"6f3e765ccb66a375f962466585ccd1ea6aefa884","profileSha256":"d6385b534a5d03277b47cc614443f4428065cdd14626dc37e21499374cda7ce6"},
  "b2ce650791fca81674f10bd4f9dd768d53efd185": {"treeOid":"e05e49fa001204d93f1467736c44602d68311ed6","profileSha256":"deb9e446af4cb3326f41bc3dbea234885a727051bd790722368846bb81c03018"},
  "c5e61fcd8ef0ac1e055c5f98ffb98bc6857d44e2": {"treeOid":"5d30243bb0b464aba1007a7efb17fcd32a6dbba5","profileSha256":"28d54fd4e918af2d6333b40871237ecb266c59fa4081188311c1c0eb55dde463"},
  "d632773365867a979084876426d74f6a584e6f2c": {"treeOid":"5ead75d605c1a1e41951665f00b770e4771c002a","profileSha256":"969f28838b8a069fc8374555cebd154363974a8ace3cc42d35eeccfab558fd07"},
  "d789070e4c186be67a474ae3851fb6da7f624179": {"treeOid":"ffbf617bd75974ae1d345325e77e0f0ca69fbe5b","profileSha256":"0f0d7900a58ed2012d61fc8e0d79a7bd482704bab8adef690c364a5f9e4ace95"},
  "e01ad6b6e6e319d63440f84b836f22594897b1d4": {"treeOid":"6399666aa67c666c52130aec93f2c6be95efbc20","profileSha256":"3ac3bd43c133b67875eaa711a8be3e4ed5832479857f979d879dcd77082869b7"},
  "e4040282b708d632bb4d45a45180905525b4da8a": {"treeOid":"ec01b34a72a3e1d417917a320f2dea239768ba23","profileSha256":"e2f8462fdcc6cb026f0d6d3449cc86c8e97e4cacfbfb9889153b6df71dccf8e6"},
  "e6ee380122131505583a106437542591badf2172": {"treeOid":"59938d0dd865fbd80bd56b9b2dd8a3a322221a52","profileSha256":"e6f0f75794ddddacbe84adb00b5502a1012fa257baba571394640f5cc1c67f01"},
  "e82645b6c045ce88dbaacf3c32cff8606a8592a8": {"treeOid":"eca5b5ead0d026822a68788f9332ae550f6fbfe0","profileSha256":"c746ac0183027a202f932c3c47465743799ceed3f26815ec090403a1f3182b13","sourceProfileCommit":"45223fec3ee71bf63cfb0e44a94a0a7b3e282ca1"},
  "ea1772b20453a494dcd3ff635066ebd385906f6b": {"treeOid":"87087786f4795b67eb4781efc0c8dc5a1c71c937","profileSha256":"dc00e364f01be0da4f591913cb4c69ac6cbc43e7f388033bf3de78ed71319484"},
  "fd08fe169b529f7d9edde3197873136a991ce863": {"treeOid":"96428ec3cb30f98f6809fab459e6172eb043f534","profileSha256":"07e230b1cf2985f1db65bd5ee7a39c07b631cb80d74730f2bc5eab17d094e0d8"},
};
const proofs = new WeakSet(), sqlProofs = new WeakSet(), storeProofs = new WeakSet(), privateOriginalValues = new WeakMap(), privateSqlContexts = new WeakMap();
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

function materializeExactSourceProfile(sourceCommit, storedProfile) {
  const selected = approved[sourceCommit], sourceProfileCommit = selected?.sourceProfileCommit;
  if (!sourceProfileCommit) return storedProfile;
  const stored = approved[sourceProfileCommit];
  demand(stored && stored.sourceProfileCommit === undefined && selected.treeOid === stored.treeOid &&
    storedProfile?.sourceCommit === sourceProfileCommit && storedProfile.inventory?.sourceCommit === sourceProfileCommit &&
    storedProfile.treeOid === stored.treeOid && historicalSourceSha256(storedProfile) === stored.profileSha256 &&
    historicalSourceSha256(storedProfile.inventory) === storedProfile.sourceInventorySha256);
  const inventory = { ...storedProfile.inventory, sourceCommit };
  const materialized = { ...storedProfile, sourceCommit, sourceInventorySha256: historicalSourceSha256(inventory), inventory };
  demand(historicalSourceSha256(materialized) === selected.profileSha256);
  return materialized;
}

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
    profile = materializeExactSourceProfile(sourceCommit, profile);
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
    const profileCommit = approved[sourceCommit].sourceProfileCommit ?? sourceCommit;
    const profile = JSON.parse(readFileSync(new URL(`./profiles/frontend-historical-sources/${profileCommit}.json`, import.meta.url), "utf8"));
    return verifyHistoricalFrontendSourceProfile(repository, sourceCommit, profile);
  } catch { throw refusal(); }
}

const providerCredentialValueKeys = Object.freeze({ squareRetiredToken: "SQUARE_ACCESS_TOKEN", resendRetiredToken: "RESEND_API_KEY",
  chitchatsRetiredToken: "CHITCHATS_ACCESS_TOKEN", googleIdentityRetiredSecret: "AUTH_GOOGLE_SECRET",
  googleCalendarRetiredSecret: "GOOGLE_CLIENT_SECRET" });
const providerSelectorValueKeys = Object.freeze({ squareRetiredToken: ["SQUARE_ENVIRONMENT", "SQUARE_LOCATION_ID", "SQUARE_APPLICATION_ID"],
  chitchatsRetiredToken: ["CHITCHATS_ENVIRONMENT", "CHITCHATS_CLIENT_ID"], googleIdentityRetiredSecret: ["AUTH_GOOGLE_ID"],
  googleCalendarRetiredSecret: ["GOOGLE_CLIENT_ID"] });
const redisCredentialKeys = Object.freeze(["KV_REST_API_URL", "KV_REST_API_TOKEN"]);
const redisLabelKeys = Object.freeze(["VERCEL_TARGET_ENV", "VERCEL_ENV"]);

function originalMetadata(requirements, binding, original) {
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
  demand(JSON.stringify(provenance.nonSecretSelectors ?? null) === JSON.stringify(selected.nonSecretSelectors ?? null));
  const catalog = new Set(original.keyCatalog);
  if (provenance.nonSecretSelectors !== undefined) demand(provenance.nonSecretSelectors && typeof provenance.nonSecretSelectors === "object" &&
    !Array.isArray(provenance.nonSecretSelectors) && Object.keys(provenance.nonSecretSelectors).every(key => key === "APP_ENV") &&
    Object.entries(provenance.nonSecretSelectors).every(([key, value]) => ["local", "staging", "production"].includes(value) && catalog.has(key)));
  if (selected.kind === "deployment") demand(selected.entrypoint === null);
  else demand(requirements.manualCredentialProfiles.includes(selected.entrypoint));
  return { selected, provenance, keyCatalog: original.keyCatalog, catalog };
}

function requiredOriginalValueKeys(requirements, binding, metadata) {
  const { catalog, provenance } = metadata, required = new Set(requirements.sqlCredentialRequirements.filter(row => catalog.has(row.key)).map(row => row.key));
  if (redisCredentialKeys.every(key => catalog.has(key))) {
    for (const key of redisCredentialKeys) required.add(key);
    for (const key of redisLabelKeys) if (catalog.has(key)) required.add(key);
  }
  const staged = provenance.nonSecretSelectors?.APP_ENV === "staging";
  demand(binding.providerCredentials === undefined || Array.isArray(binding.providerCredentials));
  for (const row of binding.providerCredentials ?? []) {
    const credential = providerCredentialValueKeys[row?.runtimeKey];
    if (credential && catalog.has(credential)) required.add(credential);
    if (!staged) continue;
    const selectors = providerSelectorValueKeys[row?.runtimeKey];
    if (selectors?.every(key => catalog.has(key))) for (const key of selectors) required.add(key);
    if (row?.runtimeKey === "googleCalendarRetiredSecret" && catalog.has("GOOGLE_CLIENT_ID") && catalog.has("GOOGLE_CALENDAR_ID")) required.add("GOOGLE_CALENDAR_ID");
  }
  return [...required].sort();
}

export function historicalSourceOriginalValueKeys(requirements, binding, original) {
  try { return freeze(requiredOriginalValueKeys(requirements, binding, originalMetadata(requirements, binding, original))); }
  catch { throw refusal(); }
}

function originalConfiguration(requirements, binding, original) {
  const metadata = originalMetadata(requirements, binding, original), requiredValueKeys = requiredOriginalValueKeys(requirements, binding, metadata);
  demand(original.environment && typeof original.environment === "object" && !Array.isArray(original.environment) &&
    JSON.stringify(Object.keys(original.environment).sort()) === JSON.stringify(requiredValueKeys) && Object.values(original.environment).every(value => typeof value === "string") &&
    Object.values(Object.getOwnPropertyDescriptors(original.environment)).every(property => "value" in property));
  return { ...metadata, values: original.environment, requiredValueKeys };
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
    const { selected, catalog, requiredValueKeys } = originalConfiguration(requirements, binding, original);
    const configuredSqlKeys = requirements.sqlCredentialRequirements.filter(row => catalog.has(row.key)).map(row => row.key).sort();
    demand(Array.isArray(selected.databaseRoles) && new Set(selected.databaseRoles.map(row => row.key)).size === selected.databaseRoles.length &&
      JSON.stringify(selected.databaseRoles.map(row => row.key).sort()) === JSON.stringify(configuredSqlKeys) &&
      selected.databaseRoles.every(row => configuredSqlKeys.includes(row.key) && /^[a-z_][a-z0-9_]{0,62}$/u.test(row.name) && /^[1-9][0-9]{0,9}$/u.test(row.oid)));
    return freeze({ version: 1, sourceCommit: requirements.sourceCommit, surfaceSha256: binding.surfaceSha256,
      configurationRecordSha256: binding.configurationRecordSha256, provenanceSha256: selected.provenanceSha256,
      configuredSqlKeys, requiredValueKeys, databaseRoles: selected.databaseRoles.map(row => ({ key: row.key, name: row.name, oid: row.oid })) });
  } catch { throw refusal(); }
}

export async function observeHistoricalSourceSqlCredentials(requirements, input) {
  try {
    const { binding, originalConfiguration: original, clientsByKey, verifySession } = input;
    const { selected, catalog, values: inputValues, requiredValueKeys } = originalConfiguration(requirements, binding, original), plan = historicalSourceSqlCredentialQueryPlan(requirements);
    prepareHistoricalSourceOriginalConfiguration(requirements, binding, original);
    const values = Object.fromEntries(Object.entries(inputValues));
    demand(clientsByKey instanceof Map && typeof verifySession === "function" &&
      (input.physicalDatabase || input.physicalDatabasesByKey instanceof Map));
    demand(Array.isArray(selected.databaseRoles) && new Set(selected.databaseRoles.map(row => row.key)).size === selected.databaseRoles.length);
    const databaseRolesSha256 = historicalSourceSha256(selected.databaseRoles);
    await verifySession();
    demand(requiredValueKeys.every(key => original.environment[key] === values[key]));
    const facts = [];
    for (const requirement of plan.credentials) {
      const configured = catalog.has(requirement.key);
      if (!configured) { demand(!clientsByKey.has(requirement.key)); facts.push({ ...requirement, disposition: "absent-from-immutable-original-key-catalog" }); continue; }
      const client = clientsByKey.get(requirement.key), role = selected.databaseRoles.find(row => row.key === requirement.key);
      const database = input.physicalDatabasesByKey?.get(requirement.key) ?? input.physicalDatabase;
      demand(database && typeof database.database === "string" && [16, 18].includes(database.major) && Number.isInteger(database.parentPid) &&
        Array.isArray(database.markers) && database.markers.length === 4 && new Set(database.markers).size === 4 &&
        database.markers.every(value => typeof value === "string" && /^[1-9][0-9]{0,18}$/u.test(value)));
      demand(client && role && /^[a-z_][a-z0-9_]{0,62}$/u.test(role.name) && /^[1-9][0-9]{0,9}$/u.test(role.oid) &&
        client.connection?.stream?.encrypted === true && client.connection.stream.authorized === true);
      const url = new URL(values[requirement.key]);
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
    const configuredKeys = plan.credentials.filter(row => catalog.has(row.key)).map(row => row.key).sort();
    demand(JSON.stringify([...clientsByKey.keys()].sort()) === JSON.stringify(configuredKeys) &&
      JSON.stringify(selected.databaseRoles.map(row => row.key).sort()) === JSON.stringify(configuredKeys));
    if (input.physicalDatabasesByKey) demand(JSON.stringify([...input.physicalDatabasesByKey.keys()].sort()) === JSON.stringify(configuredKeys));
    await verifySession();
    const current = originalConfiguration(requirements, binding, original);
    demand(JSON.stringify(current.keyCatalog) === JSON.stringify([...catalog]) && requiredValueKeys.every(key => current.values[key] === values[key]) &&
      historicalSourceSha256(selected.databaseRoles) === databaseRolesSha256);
    const result = freeze({ version: 1, sourceCommit: requirements.sourceCommit, sourceInventorySha256: requirements.sourceInventorySha256,
      requirementsSha256: requirements.requirementsSha256, surfaceSha256: binding.surfaceSha256, configurationRecordSha256: binding.configurationRecordSha256,
      provenanceSha256: selected.provenanceSha256, databaseRolesSha256, facts, evidenceSha256: historicalSourceSha256({ sourceCommit: requirements.sourceCommit,
        surfaceSha256: binding.surfaceSha256, configurationRecordSha256: binding.configurationRecordSha256, provenanceSha256: selected.provenanceSha256, databaseRolesSha256, facts }) });
    sqlProofs.add(result); privateOriginalValues.set(result, { keyCatalog: [...catalog], values });
    privateSqlContexts.set(result, { ...input, clientsByKey: new Map(clientsByKey),
      physicalDatabase: input.physicalDatabase ? structuredClone(input.physicalDatabase) : undefined,
      physicalDatabasesByKey: input.physicalDatabasesByKey ? new Map([...input.physicalDatabasesByKey].map(([key, value]) => [key, structuredClone(value)])) : undefined });
    return result;
  } catch { throw refusal(); }
}

export function deriveHistoricalSourceCapabilityClosures(requirements, binding, original, sqlEvidence, storeEvidence) {
  try {
    const { keyCatalog, values: currentValues, selected } = originalConfiguration(requirements, binding, original);
    demand(sqlProofs.has(sqlEvidence) && sqlEvidence.sourceCommit === requirements.sourceCommit && sqlEvidence.requirementsSha256 === requirements.requirementsSha256 &&
      sqlEvidence.surfaceSha256 === binding.surfaceSha256 && sqlEvidence.configurationRecordSha256 === binding.configurationRecordSha256 && sqlEvidence.provenanceSha256 === selected.provenanceSha256);
    const retained = privateOriginalValues.get(sqlEvidence);
    demand(retained && JSON.stringify(retained.keyCatalog) === JSON.stringify(keyCatalog) && Object.keys(retained.values).every(key => currentValues[key] === retained.values[key]) &&
      historicalSourceSha256(selected.databaseRoles) === sqlEvidence.databaseRolesSha256);
    const catalog = new Set(retained.keyCatalog);
    if (storeEvidence !== undefined) demand(storeProofs.has(storeEvidence) && storeEvidence.sqlEvidenceSha256 === sqlEvidence.evidenceSha256 &&
      storeEvidence.sourceCommit === requirements.sourceCommit && storeEvidence.surfaceSha256 === binding.surfaceSha256 &&
      storeEvidence.configurationRecordSha256 === binding.configurationRecordSha256 && storeEvidence.provenanceSha256 === selected.provenanceSha256);
    const capabilityClosures = [];
    for (const family of requirements.providerFamilies) {
      const absent = family.sourceDisposition === "absent-from-verified-source";
      const paths = family.configurationConditions[0]?.requiredCredentialPaths ?? [];
      // A retained key with a masked, empty or invalid value is not absence.
      // Only its omission from the bound original full key catalog qualifies.
      const noCapability = paths.length > 0 && paths.every(path => path.some(key => !catalog.has(key)));
      const sourceConditions = family.configurationConditions[0];
      const executionClosed = sourceConditions?.mutationExecutions && !sourceConditions.mutationExecutions.some(execution =>
        execution.kind === selected.kind && (execution.kind === "deployment" || execution.entrypoint === selected.entrypoint));
      const guarded = sourceConditions?.originalSelectorClosures?.some(condition => condition.kind === selected.kind &&
        original.provenance.nonSecretSelectors?.[condition.key] === condition.equals);
      const predicate = privateSqlPredicate(requirements, family, selected, catalog, sqlEvidence);
      // Concrete retained grants/events/continuations are contradictions, never a
      // shortcut from a current empty store to historical request completeness.
      const contradicted = family.provider === "google" && storeEvidence?.hasRetainedGoogleState;
      if (contradicted || (!absent && !noCapability && !executionClosed && !guarded && !predicate)) continue;
      const requirementIds = [...new Set([...requirements.sqlCredentialRequirements, ...family.configurationConditions,
        ...family.sqlIntentRequirements, ...family.untrackedPotentialRequests].map(row => row.requirementId))].sort();
      capabilityClosures.push({ familyId: family.familyId, sourceCommit: requirements.sourceCommit, surfaceSha256: binding.surfaceSha256,
        configurationRecordSha256: binding.configurationRecordSha256, provenanceSha256: selected.provenanceSha256,
        disposition: absent ? "absent-from-verified-source" : "no-capability-observed", requirementIds,
        ...(predicate ? { effectScope: "frontend-private-sql-and-protected-continuations", sourcePredicate: family.configurationConditions[0].privateSqlPredicate,
          externalProviderCapability: ["sanity.editorial", "mux.studio"].includes(family.familyId) ? "not-declared-absent" : "not-a-provider-retirement-receipt" } : {}),
        evidenceIds: [...new Set([requirements.sourceInventorySha256, requirements.requirementsSha256, binding.configurationRecordSha256, selected.provenanceSha256, sqlEvidence.evidenceSha256, ...(storeEvidence ? [storeEvidence.evidenceSha256] : [])])].sort() });
    }
    const unresolvedFrontendSqlFamilyIds = requirements.providerFamilies.filter(family => !capabilityClosures.some(row => row.familyId === family.familyId)).map(row => row.familyId).sort();
    // These exact reviewed source families retain external editorial/media
    // capability even when their frontend-private-SQL scope is inapplicable.
    // A broad consumer must never interpret a scoped exclusion as retirement.
    const externalPredicates = { "sanity.editorial": "sanity-editorial-private-sql-scope-v1", "mux.studio": "mux-public-editorial-private-sql-scope-v1" };
    const unresolvedExternalCapabilityFamilyIds = requirements.providerFamilies.filter(family => family.sourceDisposition === "reachable" &&
      Object.hasOwn(externalPredicates, family.familyId) && family.configurationConditions[0]?.privateSqlPredicate === externalPredicates[family.familyId]).map(row => row.familyId).sort();
    const unresolvedFamilyIds = [...new Set([...unresolvedFrontendSqlFamilyIds, ...unresolvedExternalCapabilityFamilyIds])].sort();
    return freeze({ version: 1, sourceCommit: requirements.sourceCommit, treeOid: requirements.treeOid,
      sourceInventorySha256: requirements.sourceInventorySha256, requirementsSha256: requirements.requirementsSha256,
      surfaceSha256: binding.surfaceSha256, configurationRecordSha256: binding.configurationRecordSha256, provenanceSha256: selected.provenanceSha256, capabilityClosures,
      unresolvedFrontendSqlFamilyIds, unresolvedExternalCapabilityFamilyIds, unresolvedFamilyIds });
  } catch { throw refusal(); }
}


const authSigningKeys = ["AUTH_SECRET", "NEXTAUTH_SECRET", "AUTH_SECRET_1", "AUTH_SECRET_2", "AUTH_SECRET_3"];
const calendarClientKeys = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "BOOKING_ADMIN_SETUP_SECRET", "KV_REST_API_URL", "KV_REST_API_TOKEN"];
function privateSqlPredicate(requirements, family, selected, catalog, sqlEvidence) {
  const predicate = family.configurationConditions[0]?.privateSqlPredicate;
  if (!predicate) return false;
  // All admitted manual programs are individually source-reviewed. None imports
  // these six mutation paths; arbitrary direct helper/operator calls are refused.
  if (selected.kind === "direct-caller") return requirements.manualCredentialProfiles.includes(selected.entrypoint);
  const absent = key => !catalog.has(key);
  const sqlAbsent = sqlEvidence.facts.every(row => row.disposition === "absent-from-immutable-original-key-catalog");
  const authBlocked = authSigningKeys.every(absent);
  const storesAbsent = sqlAbsent && ["KV_REST_API_URL", "KV_REST_API_TOKEN"].every(absent);
  const clientBlocked = calendarClientKeys.some(absent);
  switch (predicate) {
    case "google-auth-signing-absence-v1": return authBlocked && storesAbsent;
    case "google-oauth-all-alternate-paths-v1": return authBlocked && storesAbsent && clientBlocked;
    case "google-calendar-all-alternate-paths-v1": return storesAbsent && clientBlocked;
    case "sanity-signed-private-sql-ingress-v1": return absent("SANITY_WEBHOOK_SECRET");
    case "sanity-editorial-private-sql-scope-v1": return sqlAbsent || absent("SANITY_WEBHOOK_SECRET");
    case "mux-public-editorial-private-sql-scope-v1": return true;
    default: return false;
  }
}

export function historicalSourceAlternateStoreQueryPlan(requirements) {
  demand(proofs.has(requirements));
  return freeze({ version: 1, sourceCommit: requirements.sourceCommit, requirementsSha256: requirements.requirementsSha256,
    sql: [
      { id: "google.connection-rows", query: "SELECT count(*)::int AS count FROM booking_calendar_connections WHERE provider='google'" },
      { id: "google.encrypted-or-reference-grants", query: "SELECT count(*)::int AS count FROM booking_calendar_connections WHERE provider='google' AND (credential_ciphertext IS NOT NULL OR credential_secret_ref IS NOT NULL)" },
      { id: "google.hold-event-references", query: "SELECT count(*)::int AS count FROM appointment_holds WHERE google_event_id IS NOT NULL" },
      { id: "google.appointment-event-references", query: "SELECT count(*)::int AS count FROM appointment_calendar_events" },
      { id: "google.checkout-continuations", query: "SELECT count(*)::int AS count FROM checkout_orders WHERE calendar_event_id IS NOT NULL OR calendar_finalization_status::text='paid_calendar_pending'" },
    ],
    redis: { credentials: ["KV_REST_API_URL", "KV_REST_API_TOKEN"], operations: ["EXISTS", "SCAN"],
      refreshKeys: ["booking:google-refresh-token:<original-deployment-label>", "booking:google-refresh-token"],
      scanPatterns: ["booking:calendar-oauth-state:*", "booking:lock:*", "booking:idempotency:*"], fixedLock: "booking:calendar-lock", maximumPagesPerPattern: 100, countHint: 100 },
    configuredStoreEmptyDisposition: "unresolved-historical-accepted-request-completeness" });
}

function redisRead(url, token, command) {
  // Exact Upstash REST command transport. No redirects, provider writes, GET of
  // grant values, response-body diagnostics, caller endpoint or TLS overrides.
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(command), req = httpsRequest(url, { method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: 5000 }, res => {
      const chunks = []; let length = 0;
      res.on("data", chunk => { length += chunk.length; if (length > 1_000_000) res.destroy(refusal()); else chunks.push(chunk); });
      res.on("error", () => reject(refusal()));
      res.on("end", () => { try { demand(res.statusCode === 200); const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        demand(value && !Object.hasOwn(value, "error") && Object.hasOwn(value, "result")); resolve(value.result); } catch { reject(refusal()); } });
    });
    req.on("timeout", () => req.destroy(refusal())); req.on("error", () => reject(refusal())); req.end(body);
  });
}

export async function observeHistoricalSourceAlternateStores(requirements, binding, original, sqlEvidence) {
  try {
    // Also revalidates in-process branding, exact source/surface/original context,
    // unchanged private original values and original role metadata.
    deriveHistoricalSourceCapabilityClosures(requirements, binding, original, sqlEvidence);
    const context = privateSqlContexts.get(sqlEvidence), retained = privateOriginalValues.get(sqlEvidence);
    demand(context && retained); const catalog = new Set(retained.keyCatalog), values = retained.values;
    const plan = historicalSourceAlternateStoreQueryPlan(requirements);
    // Application rows may be read only from the selected parent-bound database.
    // Other original database credentials are metadata-only in this collector.
    if (context.clientsByKey.size) demand(context.physicalDatabase && [...context.clientsByKey.keys()].every(key => {
      const actual = context.physicalDatabasesByKey?.get(key) ?? context.physicalDatabase;
      return historicalSourceSha256(actual) === historicalSourceSha256(context.physicalDatabase);
    }));
    await observeHistoricalSourceSqlCredentials(requirements, context);
    const readSql = async () => {
      const facts = [];
      for (const [key, client] of context.clientsByKey) for (const item of plan.sql) {
        await context.verifySession(key); const rows = (await client.query(item.query)).rows;
        demand(rows.length === 1 && Number.isSafeInteger(rows[0].count) && rows[0].count >= 0);
        facts.push({ key, requirement: item.id, count: rows[0].count });
      }
      return facts;
    };
    const readRedis = async () => {
      const present = plan.redis.credentials.filter(key => catalog.has(key));
      if (!present.length) return { disposition: "absent-from-immutable-original-key-catalog", observations: [] };
      // A partial, masked, empty or unavailable original store is uncertainty.
      demand(present.length === 2);
      const token = values.KV_REST_API_TOKEN, url = new URL(values.KV_REST_API_URL);
      demand(url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash &&
        typeof token === "string" && token.length > 0 && !/[\r\n]/u.test(token));
      const label = (values.VERCEL_TARGET_ENV?.trim() || values.VERCEL_ENV?.trim() || "development").toLowerCase();
      const observedRead = async command => {
        await context.verifySession();
        try { return await redisRead(url, token, command); } finally { await context.verifySession(); }
      };
      const observations = [];
      for (const [id, key] of [["scoped-refresh", `booking:google-refresh-token:${encodeURIComponent(label)}`],
        ["unscoped-refresh", "booking:google-refresh-token"], ["calendar-lock", plan.redis.fixedLock]]) {
        const count = await observedRead(["EXISTS", key]); demand(count === 0 || count === 1); observations.push({ id, count });
      }
      for (const pattern of plan.redis.scanPatterns) {
        let cursor = "0", pages = 0; const cursors = new Set(), found = new Set();
        do {
          demand(++pages <= plan.redis.maximumPagesPerPattern && !cursors.has(cursor)); cursors.add(cursor);
          const value = await observedRead(["SCAN", cursor, "MATCH", pattern, "COUNT", plan.redis.countHint]);
          demand(Array.isArray(value) && value.length === 2 && /^[0-9]{1,20}$/u.test(String(value[0])) && Array.isArray(value[1]) && value[1].length <= 1000);
          for (const key of value[1]) { demand(typeof key === "string" && key.startsWith(pattern.slice(0, -1)) && key.length <= 2048); found.add(key); }
          demand(found.size <= 10_000); cursor = String(value[0]);
        } while (cursor !== "0");
        observations.push({ id: pattern, count: found.size });
      }
      await context.verifySession(); return { disposition: "actual-original-redis-read-only-observation", observations };
    };
    const sql = await readSql(), redis = await readRedis();
    demand(historicalSourceSha256(sql) === historicalSourceSha256(await readSql()) && historicalSourceSha256(redis) === historicalSourceSha256(await readRedis()));
    await observeHistoricalSourceSqlCredentials(requirements, context);
    const facts = { version: 1, sourceCommit: requirements.sourceCommit, surfaceSha256: binding.surfaceSha256,
      configurationRecordSha256: binding.configurationRecordSha256, provenanceSha256: binding.sourceConfiguration.provenanceSha256,
      requirementsSha256: requirements.requirementsSha256, sqlEvidenceSha256: sqlEvidence.evidenceSha256, sql, redis,
      hasRetainedGoogleState: sql.some(row => row.count > 0) || redis.observations.some(row => row.count > 0),
      configuredStoreEmptyDisposition: plan.configuredStoreEmptyDisposition };
    const result = freeze({ ...facts, evidenceSha256: historicalSourceSha256(facts) }); storeProofs.add(result); return result;
  } catch { throw refusal(); }
}
