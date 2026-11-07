import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { courseWorkerPolicies, databaseConnectionBudgets, privateTlsPolicies } from "./configuration.mjs";

const model = parse(readFileSync(new URL("./compose.yaml", import.meta.url), "utf8"), { merge: true });
const example = name => Object.fromEntries(readFileSync(new URL(`./course-workers/${name}.env.example`, import.meta.url), "utf8")
  .split("\n").filter(line => line && !line.startsWith("#")).map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));

test("Course workers use distinct minimal env files without API networks, credentials or public ports", () => {
  for (const [name, policy] of Object.entries(courseWorkerPolicies)) {
    const service = model.services[name];
    assert.equal(service.image, model.services["course-publisher"].image);
    assert.deepEqual(service.command, ["node", policy.command]);
    assert.deepEqual(service.env_file, [{ path: `\${RELEASE_DIR}/${name}.env`, format: "raw" }]);
    assert.deepEqual(service.networks, [policy.network]);
    assert.deepEqual(Object.entries(model.services).filter(([, candidate]) => {
      return Array.isArray(candidate.networks) ? candidate.networks.includes(policy.network) : Object.hasOwn(candidate.networks ?? {}, policy.network);
    }).map(([candidate]) => candidate), [name]);
    assert.ok(Object.hasOwn(model.networks, policy.network));
    assert.equal(service.ports, undefined);
    assert.equal(service.volumes, undefined);
    assert.equal(service.depends_on, undefined);
    assert.deepEqual(Object.keys(service.environment).sort(), ["NODE_ENV", "NODE_OPTIONS", "PORT"]);
    assert.equal(service.environment.PORT, policy.port);
    assert.equal(service.environment.NODE_ENV, "production");
    for (const peers of Object.values(privateTlsPolicies()).map(value => value.peers)) {
      assert.ok(peers.every(peer => !peer.routes.some(route => route.path.includes("media-recovery") || route.path.includes("export-cleanup"))));
    }
  }
  const ports = Object.values(model.services).map(service => service.environment?.PORT).filter(Boolean);
  assert.equal(new Set(ports).size, ports.length);
});

test("examples leave every new loop disabled and omit unrelated secrets; Compose does not override enablement", () => {
  for (const [name, policy] of Object.entries(courseWorkerPolicies)) {
    const values = example(name);
    assert.equal(values.DATABASE_TARGET, "staging");
    assert.equal(new URL(values.STAGING_DATABASE_URL).hostname, "database.invalid");
    for (const flag of policy.disabledFlags) {
      assert.equal(values[flag], "false");
      assert.equal(model.services[name].environment[flag], undefined);
    }
    for (const key of Object.keys(values)) assert.ok(policy.environmentKeys.includes(key), key);
    for (const key of ["DATABASE_URL", "DEV_DATABASE_URL", "TEST_DATABASE_URL", "JWT_SECRET", "JWT_PRIVATE_KEY", "JWT_PUBLIC_KEY", "MUX_SIGNING_KEY_ID", "MUX_SIGNING_PRIVATE_KEY", "MUX_WEBHOOK_SECRET", "COMMUNITY_ENROLLMENT_SERVICE_JWT_SECRET"]) {
      assert.ok(!policy.environmentKeys.includes(key), key);
      assert.equal(values[key], undefined);
    }
  }
  assert.ok(!courseWorkerPolicies["course-export-cleanup"].environmentKeys.some(key => key.startsWith("MUX_")));
});

test("disabled workers retain bounded readiness probes and graceful stop with existing hardening", () => {
  for (const name of Object.keys(courseWorkerPolicies)) {
    const service = model.services[name];
    assert.equal(service.read_only, true);
    assert.deepEqual(service.cap_drop, ["ALL"]);
    assert.deepEqual(service.security_opt, ["no-new-privileges:true"]);
    assert.equal(service.init, true);
    assert.equal(service.stop_grace_period, "60s");
    assert.equal(service.mem_limit, "192m");
    assert.equal(service.cpus, 0.2);
    assert.equal(service.environment.NODE_OPTIONS, "--max-old-space-size=128");
    assert.deepEqual(service.healthcheck, model.services["course-snapshot"].healthcheck);
    assert.match(service.healthcheck.test.at(-1), /process\.env\.PORT\+'\/ready'/u);
    assert.equal(service.healthcheck.timeout, "4s");
  }
});

test("connection budget counts all five Course pools and resource deltas stay on the existing host", () => {
  const courseProcesses = Object.values(model.services).filter(service => service.image.includes("${COURSE_RUNTIME_IMAGE"));
  assert.equal(courseProcesses.length, databaseConnectionBudgets.course.runtimeProcesses);
  assert.equal(databaseConnectionBudgets.course.runtimeMaximum, courseProcesses.length * (10 + 1));
  assert.equal(databaseConnectionBudgets.course.migrationMaximum, 1);
  assert.equal(databaseConnectionBudgets.course.requiredLimit, 60);
  const normal = Object.values(model.services).filter(service => !service.profiles);
  assert.equal(normal.length, 10);
  assert.equal(normal.reduce((sum, service) => sum + Number(service.mem_limit.slice(0, -1)), 0), 2688);
  assert.equal(Object.values(model.services).reduce((sum, service) => sum + Number(service.mem_limit.slice(0, -1)), 0), 3200);
});
