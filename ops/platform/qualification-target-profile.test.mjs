import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  decodeQualificationTargetJson, parseQualificationTargetProfileRef, QualificationTargetProfileError,
  requireQualificationTargetProfile, resolveQualificationTargetProfile,
  STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as current,
} from "./qualification-target-profile.mjs";

const REFUSED = "QUALIFICATION_TARGET_PROFILE_REFUSED";
const canonical = '{"environment":"staging","frontend":{"canonicalOrigin":"https://staging.lashher.com","projectId":"prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM","teamId":"team_2Hrn5eMZyZxfAWdmYvyKi9t3","workloadEnvironment":"production"},"gateway":{"publicOrigin":"https://api-staging.lashher.com"},"id":"staging-current","kind":"existing-staging","selectionPolicy":"existing-staging-v1","version":1}';
const definition = JSON.parse(canonical);
const envelope = { version: 1, profiles: [definition] };
const fails = (run, code = REFUSED) => assert.throws(run, error => error instanceof QualificationTargetProfileError && error.code === code && error.message === code);

test("source registry resolves the exact canonical vector without granting observed or live authority", () => {
  const policy = resolveQualificationTargetProfile(current);
  assert.equal(Buffer.byteLength(canonical), 371);
  assert.equal(JSON.stringify(policy), canonical);
  assert.deepEqual(current, { version: 1, id: "staging-current", sha256: "ea88751524540bfe177e089680b41d6f35b2454d73d17ef9a40b7663381225ba" });
  assert.equal(createHash("sha256").update(canonical).digest("hex"), current.sha256);
  assert.equal(policy.kind, "existing-staging");
  assert.equal(policy.selectionPolicy, "existing-staging-v1");
  assert.equal(Object.hasOwn(policy, "databases"), false);
  assert.equal(Object.hasOwn(policy, "hostMachineId"), false);
  assert.equal(Object.hasOwn(policy, "releaseAccepted"), false);
  assert.ok(Object.isFrozen(policy) && Object.isFrozen(policy.frontend) && Object.isFrozen(policy.gateway) && Object.isFrozen(current));
  assert.notEqual(resolveQualificationTargetProfile(current), policy);
  assert.throws(() => { policy.frontend.projectId = "unreviewed"; }, TypeError);
});

test("reference parsing rejects malformed, inherited, accessor, extra and unregistered identity", () => {
  for (const value of [undefined, null, [], {}, { ...current, extra: true }, { ...current, version: true },
    { ...current, version: "1" }, { ...current, version: -0 }, { ...current, id: "1-staging" },
    { ...current, id: "staging-é" }, { ...current, sha256: "sha256:" + current.sha256 },
    { ...current, sha256: current.sha256.toUpperCase() }, { ...current, sha256: "0".repeat(64) },
    { ...current, [Symbol("extra")]: true }, Object.create(current)]) fails(() => parseQualificationTargetProfileRef(value));
  const accessor = { ...current };
  Object.defineProperty(accessor, "id", { get() { throw new Error("SECRET_GETTER_CANARY"); }, enumerable: true });
  fails(() => parseQualificationTargetProfileRef(accessor));
  fails(() => parseQualificationTargetProfileRef({ ...current, id: "p2q-20261106" }), "QUALIFICATION_TARGET_PROFILE_UNKNOWN");
  fails(() => parseQualificationTargetProfileRef({ ...current, sha256: "f".repeat(64) }), "QUALIFICATION_TARGET_PROFILE_DIGEST_MISMATCH");
  assert.deepEqual(parseQualificationTargetProfileRef({ sha256: current.sha256, version: 1, id: current.id }), current);
});

test("every independently consumed carrier must contain its own matching registered reference", () => {
  const carrier = { qualificationTargetProfile: current };
  assert.deepEqual(requireQualificationTargetProfile(current, carrier, { qualificationTargetProfile: { ...current } }), current);
  fails(() => requireQualificationTargetProfile(current), "QUALIFICATION_TARGET_PROFILE_REQUIRED");
  fails(() => requireQualificationTargetProfile(current, {}), "QUALIFICATION_TARGET_PROFILE_REQUIRED");
  fails(() => requireQualificationTargetProfile(current, Object.create(carrier)));
  fails(() => requireQualificationTargetProfile(current, { qualificationTargetProfile: undefined }));
  fails(() => requireQualificationTargetProfile(current, carrier, { qualificationTargetProfile: { ...current, id: "p2q-20261106" } }), "QUALIFICATION_TARGET_PROFILE_UNKNOWN");
  fails(() => requireQualificationTargetProfile(current, carrier, { qualificationTargetProfile: { ...current, sha256: "f".repeat(64) } }), "QUALIFICATION_TARGET_PROFILE_DIGEST_MISMATCH");
});

test("raw decoding rejects decoded duplicate keys at every depth before object conversion", () => {
  for (const raw of [String.raw`{"id":1,"id":2}`, String.raw`{"id":1,"\u0069d":2}`,
    String.raw`{"x":[{"qualificationTargetProfile":{"version":1,"ver\u0073ion":1}}]}`,
    String.raw`{"__proto__":1,"__proto__":2}`]) {
    for (const kind of ["registry", "carrier", "private-packet"]) fails(() => decodeQualificationTargetJson(raw, kind));
  }
  assert.deepEqual(decodeQualificationTargetJson('{\n\t"a":{"id":1},"b":{"id":2}}', "carrier"), { a: { id: 1 }, b: { id: 2 } });
  assert.deepEqual(decodeQualificationTargetJson('{"a":null,"b":true,"c":false}', "carrier"), { a: null, b: true, c: false });
  const escaped = { text: 'quote " and slash \\; Montréal 😀' };
  assert.deepEqual(decodeQualificationTargetJson(JSON.stringify(escaped), "private-packet"), escaped);
});

test("registry and profile-version raw numbers use canonical safe integer lexemes only", () => {
  for (const token of ["1.0", "1e0", "-0", "9007199254740992"]) {
    fails(() => decodeQualificationTargetJson('{"version":' + token + '}', "registry"));
    for (const kind of ["carrier", "private-packet"]) {
      const raw = String.raw`{"nested":[{"qualificationTarget\u0050rofile":{"ver\u0073ion":` + token + "}}]}";
      fails(() => decodeQualificationTargetJson(raw, kind));
    }
  }
  assert.deepEqual(decodeQualificationTargetJson('{"fraction":1.25,"exponent":1e0,"version":1.0,"zero":-0}', "carrier"),
    { fraction: 1.25, exponent: 1, version: 1, zero: -0 });
  for (const token of ['true', 'false', 'null', '"1"', '{}', '[]']) {
    for (const kind of ["carrier", "private-packet"])
      fails(() => decodeQualificationTargetJson('{"qualificationTargetProfile":{"version":' + token + '}}', kind));
  }
  for (const token of ['1e10000', '-1e10000']) {
    for (const kind of ["registry", "carrier", "private-packet"])
      fails(() => decodeQualificationTargetJson('{"value":' + token + '}', kind));
  }
  const raw = JSON.stringify({ qualificationTargetProfile: current, fraction: 1.25 });
  assert.deepEqual(requireQualificationTargetProfile(current, decodeQualificationTargetJson(raw, "carrier")), current);
});

test("raw bounds are fixed byte limits with strict UTF-8, JSON syntax and maximum 128 containers", () => {
  for (const raw of [Buffer.from([0xff]), Buffer.from([0xc0, 0x80]), "\ufeff{}", '"\ud800"', String.raw`"\ud800"`,
    '"unterminated', '{"a":NaN}', '{"a":Infinity}', '{"a":1,}', "true false", ""]) fails(() => decodeQualificationTargetJson(raw, "carrier"));
  for (const kind of [undefined, "custom", 2_000_000, new String("carrier")]) fails(() => decodeQualificationTargetJson("{}", kind));
  for (const [kind, limit] of [["registry", 131_072], ["carrier", 2_000_000], ["private-packet", 24_000_000]])
    fails(() => decodeQualificationTargetJson(new Uint8Array(limit + 1), kind));
  assert.equal(decodeQualificationTargetJson("0" + " ".repeat(131_071), "registry"), 0);
  fails(() => decodeQualificationTargetJson(JSON.stringify({ text: "é".repeat(1_000_000) }), "carrier"));
  assert.ok(Array.isArray(decodeQualificationTargetJson("[".repeat(128) + "]".repeat(128), "carrier")));
  fails(() => decodeQualificationTargetJson("[".repeat(129) + "]".repeat(129), "carrier"));
});

function sourceImport(raw, special = false) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "p2q-source-registry-")));
  try {
    const copiedHelper = join(directory, "qualification-target-profile.mjs");
    writeFileSync(copiedHelper, readFileSync(new URL("./qualification-target-profile.mjs", import.meta.url)));
    const registry = join(directory, "qualification-target-profiles.json");
    if (special === "fifo") {
      assert.equal(spawnSync("mkfifo", [registry], { encoding: "utf8" }).status, 0);
    } else if (special) {
      const target = join(directory, "registry-target.json"); writeFileSync(target, raw); symlinkSync(target, registry);
    } else writeFileSync(registry, raw);
    return spawnSync(process.execPath, ["--input-type=module", "-e",
      `try { const m = await import(${JSON.stringify(pathToFileURL(copiedHelper).href)}); process.stdout.write(JSON.stringify(m.STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE)); }
       catch (e) { process.stderr.write(String(e.code)); process.exitCode = 1; }`], { encoding: "utf8", timeout: 10_000 });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("real source imports canonicalize formatting and refuse unreviewed registry data, not caller paths", () => {
  const reordered = { profiles: [{ ...definition, frontend: Object.fromEntries(Object.entries(definition.frontend).reverse()) }], version: 1 };
  for (const raw of [JSON.stringify(envelope), JSON.stringify(reordered, null, 2)]) {
    const result = sourceImport(raw);
    assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), current);
  }
  for (const raw of [JSON.stringify({ ...envelope, secret: "PRIVATE_REGISTRY_CANARY" }),
    JSON.stringify({ ...envelope, profiles: [] }), JSON.stringify({ ...envelope, profiles: [definition, definition] }),
    JSON.stringify({ ...envelope, profiles: [{ ...definition, id: "p2q-20261106", kind: "isolated-allocated" }] }),
    JSON.stringify({ ...envelope, profiles: [{ ...definition, frontend: { ...definition.frontend, projectId: "prj_unreviewed" } }] }),
    '{"version":1,"ver\\u0073ion":1,"profiles":[]}', JSON.stringify(envelope).replace('"version":1', '"version":1.0')]) {
    const result = sourceImport(raw);
    assert.equal(result.status, 1); assert.equal(result.stderr, REFUSED); assert.equal(result.stdout, "");
    assert.equal(result.stderr.includes("PRIVATE_REGISTRY_CANARY"), false);
  }
  const linked = sourceImport(JSON.stringify(envelope), true);
  assert.equal(linked.status, 1); assert.equal(linked.stderr, REFUSED);
  const fifo = sourceImport(JSON.stringify(envelope), "fifo");
  assert.equal(fifo.status, 1); assert.equal(fifo.stderr, REFUSED); assert.equal(fifo.error, undefined);
  const oversized = sourceImport(" ".repeat(131_073));
  assert.equal(oversized.status, 1); assert.equal(oversized.stderr, REFUSED);
});

test("helper module and source registry are independently packaged local source artifacts", () => {
  assert.ok(fileURLToPath(new URL("./qualification-target-profiles.json", import.meta.url)).endsWith("/ops/platform/qualification-target-profiles.json"));
  assert.deepEqual(JSON.parse(readFileSync(new URL("./qualification-target-profiles.json", import.meta.url))), envelope);
});


test("raw kind objects are rejected before invoking coercion or exposing a canary", () => {
  let invoked = false;
  const kind = { toString() { invoked = true; throw new Error("SECRET_KIND_CANARY"); } };
  fails(() => decodeQualificationTargetJson("{}", kind));
  assert.equal(invoked, false);
});
