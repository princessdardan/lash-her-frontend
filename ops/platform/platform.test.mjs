import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { validatePlatformRelease } from "./release.mjs";
import { privateTlsPolicies, databaseConnectionBudgets } from "./configuration.mjs";

const model = parse(readFileSync(new URL("./compose.yaml", import.meta.url), "utf8"), { merge: true });

test("isolated Mux override declares only the fixed gateway spool without changing the default layout", () => {
  const override = parse(readFileSync(new URL("./compose.p2q-mux.yaml", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(override), ["services"]);
  assert.deepEqual(Object.keys(override.services), ["gateway"]);
  assert.deepEqual(Object.keys(override.services.gateway), ["volumes"]);
  assert.deepEqual(override.services.gateway.volumes, [{
    type: "bind", source: "/run/lash-her-p2q-mux-private/capture-root", target: "/mux-capture",
    read_only: false, bind: { create_host_path: false, propagation: "rprivate" },
  }]);
  assert.equal(model.services.gateway.read_only, true);
  assert.deepEqual(model.services.gateway.volumes, [
    "${RELEASE_DIR:?select protected release directory}/gateway.json:/config/gateway.json:ro",
    "${RELEASE_DIR}/admission:/admission:ro", "${RELEASE_DIR}/tls/gateway:/tls:ro",
  ]);
  // This source-model check does not prove Compose merge semantics, actual
  // mount/UID/fsync behavior or an authorized launcher. Those remain gates.
});

for (const templateName of ["lightsail-host", "lightsail-access-recovery"]) {
test(`${templateName}: Lightsail-prefixed user data runs under POSIX sh and emits valid SSH lines`, () => {
  const template = JSON.parse(readFileSync(new URL(`../aws/${templateName}.cfn.json`, import.meta.url), "utf8"));
  const lines = template.Resources.ApiHost.Properties.UserData["Fn::Join"][1];
  const rendered = lines.map((line) => typeof line === "string" ? line : line["Fn::Sub"].replaceAll("${OperatorIpv4Cidr}", "192.0.2.1/32")).join("\n");
  // Some development /bin/sh implementations accept this extension, unlike
  // the actual Ubuntu 24.04 host. Keep the known incompatible option out even
  // when the test runner's newer shell happens to support it.
  assert.doesNotMatch(rendered, /^\s*set[^\n]*\bpipefail\b/mu);
  assert.equal(spawnSync("sh", ["-n"], { input: rendered, encoding: "utf8" }).status, 0);
  // Actual Lightsail prepends its initialization under /bin/sh. An inner Bash
  // shebang cannot select Bash, and `set -o pipefail` fails before any setup.
  const header = spawnSync("sh", ["-c", `true\n${lines.slice(0, 3).join("\n")}\nprintf ready`], { encoding: "utf8" });
  assert.equal(header.status, 0, header.stderr);
  assert.equal(header.stdout, "ready");
  const sshCommand = lines.find((line) => typeof line === "string" && line.includes("PasswordAuthentication no"));
  const print = spawnSync("sh", ["-c", sshCommand.split(" > ")[0]], { encoding: "utf8" });
  assert.equal(print.status, 0, print.stderr);
  assert.equal(print.stdout, "PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n");
});
}

test("monitoring is deferred outside the default runtime and release gate", () => {
  assert.equal(model.services.collector, undefined);
  assert.equal(model.services["node-exporter"], undefined);
  const source = readFileSync(new URL("./compose.yaml", import.meta.url), "utf8");
  assert.ok(!source.includes("PROMETHEUS_IMAGE") && !source.includes("NODE_EXPORTER_IMAGE"));
  const prepared = parse(readFileSync(new URL("./compose.monitoring.yaml", import.meta.url), "utf8"), { merge: true });
  assert.equal(prepared.services.collector.ports, undefined);
  assert.equal(prepared.services["node-exporter"].ports, undefined);
  const candidate = JSON.parse(readFileSync(new URL("./release.candidate.json", import.meta.url), "utf8"));
  assert.equal(candidate.operator.name, "Dardan");
  assert.equal(candidate.operator.mode, "sole-operator");
  assert.equal(candidate.monitoring.state, "deferred");
  const failures = validatePlatformRelease(candidate);
  assert.ok(!failures.some((value) => /collector|hostExporter|Off-host monitoring/u.test(value)));
  assert.ok(failures.includes("Operator approval for this release and environment required"));
});

test("topology publishes only gateway HTTPS; runtime and migration security boundaries cannot regress", () => {
  for (const [name, service] of Object.entries(model.services)) {
    assert.equal(service.read_only, true, name);
    assert.deepEqual(service.cap_drop, ["ALL"], name);
    assert.deepEqual(service.security_opt, ["no-new-privileges:true"], name);
    assert.ok(service.mem_limit && service.cpus && service.pids_limit, name);
    assert.ok(!service.privileged && service.network_mode !== "host", name);
    assert.ok(!(service.volumes ?? []).some((value) => /docker\.sock/u.test(value)), name);
    if (name === "gateway") assert.deepEqual(service.ports, ["0.0.0.0:443:8443"]);
    else assert.equal(service.ports, undefined, name);
    if (name.endsWith("-migration")) {
      assert.deepEqual(service.profiles, ["migration-inspection"]);
      assert.equal(service.restart, "no");
      assert.ok(service.command.includes("--manifest-only"));
      assert.equal(service.env_file, undefined);
    }
  }
  assert.equal(model.networks.mesh.internal, true);
  assert.equal(model.networks.course_backend.internal, true);
  assert.equal(model.networks.community_backend.internal, true);
  assert.equal(model.services["course-api"].environment.HTTP_BIND_ADDRESS, "172.29.20.10");
  assert.equal(model.services["community-api"].environment.HTTP_BIND_ADDRESS, "172.29.30.10");
  assert.equal(model.services["course-api"].environment.INTERNAL_SERVICE_TRUSTED_PROXY_CIDRS, "172.29.20.11/32");
  assert.equal(model.services["community-api"].environment.INTERNAL_TRUSTED_PROXY_CIDRS, "172.29.30.11/32");
});

test("private policies isolate workload, publisher, authority and operational peers", () => {
  const { course, community } = privateTlsPolicies();
  const workload = course.peers.find((peer) => peer.address === "172.29.10.10");
  assert.ok(!workload.routes.some((route) => route.path.startsWith("/v1/internal/community/") || route.path === "/metrics"));
  assert.equal(community.peers.length, 3);
  assert.deepEqual(community.peers[0].routes, [{ method: "POST", path: "/v1/internal/course/enrollment-events" }]);
  assert.deepEqual(community.peers.find(peer => peer.address === "172.29.10.10").routes, [
    { method: "POST", path: "/v1/internal/accounts/commands" },
    { method: "GET", path: "/v1/internal/accounts/exports/{commandId}" },
  ]);
  assert.equal(course.peers.find((peer) => peer.address === "172.29.10.31").routes.length, 1);
  for (const budget of Object.values(databaseConnectionBudgets)) {
    assert.equal(budget.runtimeMaximum, budget.runtimeProcesses * 11);
    assert.ok(budget.runtimeMaximum + budget.migrationMaximum < budget.requiredLimit);
  }
});

test("unfilled release candidate refuses and structural validation does not infer approvals", () => {
  const candidate = JSON.parse(readFileSync(new URL("./release.candidate.json", import.meta.url), "utf8"));
  const failures = validatePlatformRelease(candidate);
  assert.ok(failures.includes("Exact frontend source pin required"));
  assert.ok(failures.includes("Operator approval for this release and environment required"));
  assert.ok(failures.includes("Locked migration/lineage receipts required"));
  assert.ok(validatePlatformRelease(null).length);
});

test("release completeness needs no billing access, forecast or verified spending controls", () => {
  const now = new Date("2026-11-01T12:00:00Z");
  const source = (name) => ({
    repository: `https://github.com/princessdardan/lash-her-${name}.git`,
    commit: "1".repeat(40),
    requiredChecks: "passed",
  });
  const artifact = (name, digit) => ({
    image: `ghcr.io/princessdardan/lash-her-${name}@sha256:${digit.repeat(64)}`,
    sbomSha256: `sha256:${"a".repeat(64)}`,
    provenanceSha256: `sha256:${"b".repeat(64)}`,
    scan: "passed",
  });
  const release = {
    version: 2,
    releaseId: "staging-fixture",
    environment: "staging",
    sources: { frontend: source("frontend"), course: source("course-api"), community: source("community-api") },
    contractManifestSha256: `sha256:${"c".repeat(64)}`,
    sourceApproval: { mode: "single-operator-dispatch", operatorGithubUserId: "8996309",
      runId: "12345", runAttempt: 1, verifiedAt: "2026-11-01T11:30:00Z" },
    artifacts: {
      courseRuntime: artifact("course-runtime", "1"),
      courseMigration: artifact("course-migration", "2"),
      communityRuntime: artifact("community-runtime", "3"),
      communityMigration: artifact("community-migration", "4"),
      gateway: artifact("gateway", "5"),
      frontendMigration: artifact("frontend-migration", "6"),
    },
    approval: { state: "approved", operator: "Dardan", environment: "staging", releaseId: "staging-fixture", approvedAt: "2026-11-01T11:30:00Z" },
    migrations: { frontend: { state: "verified" }, course: { state: "verified" }, community: { state: "verified" } },
    recovery: { state: "verified" },
    workload: { environment: "production", projectId: "prj_fixture" },
    scheduler: { state: "verified", cancellation: "verified" },
  };
  assert.deepEqual(validatePlatformRelease(release, now), []);
  const missingFrontend = structuredClone(release); delete missingFrontend.migrations.frontend;
  assert.ok(validatePlatformRelease(missingFrontend, now).includes("Frontend migration/lineage receipt required"));
  const production = { ...structuredClone(release), environment: "production",
    approval: { ...release.approval, environment: "production" },
    staging: { state: "passed", releaseId: release.releaseId, verifiedAt: "2026-11-01T11:45:00Z", receiptRef: "staging/run-1",
      sources: structuredClone(release.sources), artifacts: structuredClone(release.artifacts), contractManifestSha256: release.contractManifestSha256 } };
  assert.deepEqual(validatePlatformRelease(production, now), []);
  production.artifacts.courseRuntime.image = `ghcr.io/princessdardan/lash-her-course-runtime@sha256:${"8".repeat(64)}`;
  assert.ok(validatePlatformRelease(production, now).includes("Production requires the exact staging-tested source and artifact digests"));
  assert.ok(validatePlatformRelease({ ...release, approval: { ...release.approval, environment: "production" } }, now)
    .includes("Operator approval for this release and environment required"));
  const legacy = { ...release, costs: { currency: "USD", monthlyCeiling: 50, forecastTotal: null, controlsVerified: false } };
  assert.deepEqual(validatePlatformRelease(legacy, now), []);
  assert.ok(validatePlatformRelease({ ...release, sourceApproval: undefined }, now).includes("Operator dispatch and CI evidence required"));
  const held = validatePlatformRelease({ ...legacy, approval: { state: "pending" }, migrations: {}, recovery: {}, scheduler: {} }, now);
  for (const failure of [
    "Operator approval for this release and environment required",
    "Locked migration/lineage receipts required",
    "Compatible recovery/rollback evidence required",
    "Qualified scheduler and strict cancellation required",
  ]) assert.ok(held.includes(failure), failure);
});

test("host watchdog uses the stock Python runtime and a bounded hardened systemd unit", () => {
  const unit = readFileSync(new URL("./lash-her-watchdog.service", import.meta.url), "utf8");
  const source = readFileSync(new URL("./host/watchdog.py", import.meta.url), "utf8");
  assert.ok(unit.includes("ExecStart=/usr/bin/python3 "));
  assert.ok(unit.includes("TimeoutStartSec=240"));
  assert.ok(unit.includes("ProtectSystem=strict"));
  assert.ok(source.includes('fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)'));
  assert.ok(source.includes('"/run/lock/lash-her-release.lock"'));
});

test("candidate publication uses sole-operator dispatch, a scoped read token and never deploys", () => {
  const workflow = parse(readFileSync(new URL("../../.github/workflows/platform-artifacts.yml", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  const job = workflow.jobs.candidate;
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.equal(job.environment, undefined);
  assert.ok(job.if.includes("github.actor_id == '8996309'"));
  assert.deepEqual(job.permissions, { contents: "read", actions: "read", packages: "write", "id-token": "write", attestations: "write" });
  const steps = job.steps;
  assert.ok(steps[0].run.includes('test "$GITHUB_REF" = "refs/heads/$SOURCE_BRANCH"'));
  const verifyIndex = steps.findIndex((step) => step.run?.includes('platform-evidence/source-checks.json'));
  assert.ok(verifyIndex > 0);
  assert.equal(steps[verifyIndex].env.SOURCE_READ_TOKEN, "${{ secrets.PLATFORM_SOURCE_READ_TOKEN }}");
  assert.ok(!JSON.stringify(workflow).includes("PLATFORM_SOURCE_APPROVAL"));
  assert.ok(!JSON.stringify(workflow).includes("create-github-app-token"));
  for (const step of steps.filter((step) => step.uses)) assert.match(step.uses, /@[0-9a-f]{40}$/u);
  const builds = steps.filter((step) => step.id?.startsWith("build-"));
  const crossContractIndex = steps.findIndex((step) => step.run?.includes("check-vendored-course-contract.mjs"));
  assert.ok(crossContractIndex > verifyIndex && crossContractIndex < steps.indexOf(builds[0]));
  assert.match(steps[crossContractIndex].run, /--release/u);
  const phase2Index = steps.findIndex(step => step.run?.includes("source-checkout.mjs --phase2"));
  assert.ok(phase2Index > crossContractIndex && phase2Index < steps.indexOf(builds[0]));
  assert.equal(steps.find((step) => step.with?.path === "sources/lash-her-community-api").with["fetch-depth"], 0);
  assert.equal(builds.length, 6);
  for (const build of builds) {
    assert.ok(steps.indexOf(build) > verifyIndex);
    assert.match(build.with.context, /^https:\/\/github\.com\/princessdardan\/lash-her-/u);
    assert.equal(build.with.platforms, "linux/amd64");
    assert.equal(build.with.sbom, true);
    assert.equal(build.with.provenance, "mode=max");
    assert.equal(build["continue-on-error"], undefined);
  }
  const scans = steps.filter((step) => step.uses?.startsWith("aquasecurity/trivy-action@"));
  assert.equal(scans.length, 6);
  for (const scan of scans) {
    assert.ok(scan.with["image-ref"].includes("@${{"));
    assert.ok(scan.with.output.endsWith("-raw-scan.json"));
    assert.equal(scan.with["exit-code"], "0");
    assert.equal(scan.with.severity, undefined);
    assert.equal(scan.env.TRIVY_LIST_ALL_PKGS, "true");
    const index = steps.indexOf(scan), next = steps[index + 1], retain = steps[index + 2];
    const prefix = scan.with.output.split("/").at(-1).replace("-raw-scan.json", "");
    const source = prefix.startsWith("course-") ? "course-api/ops" : prefix.startsWith("community-") ? "community-api/ops" : "frontend/ops/gateway";
    assert.ok(next.run.startsWith(`node sources/lash-her-${source}/runtime/verify.mjs `));
    assert.ok(next.run.includes(scan.with["image-ref"]));
    assert.ok(next.run.includes(`"$RUNNER_TEMP/platform-evidence/${prefix}-raw-scan.json"`));
    assert.match(next.run, /cp .*runtime\/scan\.json.*-scan\.json/u);
    assert.equal(next["continue-on-error"], undefined);
    assert.equal(retain.if, "${{ !cancelled() }}");
    assert.ok(retain.uses.startsWith("actions/upload-artifact@"));
    assert.ok(retain.with.path.includes(`${prefix}-raw-scan.json`));
    assert.ok(retain.with.path.includes(`${prefix}-runtime/`));
    assert.equal(retain.with["if-no-files-found"], "error");
    assert.equal(scan.with.version, "v0.76.1");
  }
  assert.ok(steps.some((step) => step.run?.includes("artifact-candidate.mjs --harness")));
  const collectors = steps.filter((step) => step.run?.includes("artifact-candidate.mjs"));
  assert.equal(collectors.length, 2);
  for (const step of collectors) assert.match(step.run, /^node sources\/lash-her-frontend\/ops\/platform\/artifact-candidate\.mjs/u);
  const harnessIndex = steps.findIndex((step) => step.run?.includes("local-harness.mjs"));
  assert.ok(steps[harnessIndex].run.includes("local-harness.mjs --phase p2"));
  assert.ok(steps.some(step => step.run?.includes("contracts/api-integration/p2-candidate,dst=/source/contracts/api-integration/p2-candidate,readonly")));
  const finalCheckIndex = steps.findIndex((step) => step.run?.includes("source-checks.final.json"));
  const qualificationIndex = steps.findIndex((step) => step.run?.includes("artifact-candidate.mjs --harness"));
  assert.ok(harnessIndex > verifyIndex && finalCheckIndex > harnessIndex && qualificationIndex > finalCheckIndex);
  assert.equal(workflow.on.workflow_dispatch.inputs.source_branch.default, "main");
  assert.ok(!JSON.stringify(workflow).includes("aws-actions/"));
});

test("native qualification uses the explicit supported Ubuntu baseline without altering its verifier", () => {
  const workflow = parse(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"));
  for (const key of ["frontend-operator-migrations", "gateway-and-platform", "browser-tests"]) assert.equal(workflow.jobs[key]["runs-on"], "ubuntu-24.04");
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps ?? []) {
    if (step.run?.includes("ops/gateway/runtime/verify.mjs")) assert.equal(step["continue-on-error"], undefined);
  }
});
