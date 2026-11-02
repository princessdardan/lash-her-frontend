import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { validatePlatformRelease } from "./release.mjs";
import { privateTlsPolicies, databaseConnectionBudgets } from "./configuration.mjs";

const model = parse(readFileSync(new URL("./compose.yaml", import.meta.url), "utf8"), { merge: true });

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
  assert.equal(community.peers.length, 2);
  assert.deepEqual(community.peers[0].routes, [{ method: "POST", path: "/v1/internal/course/enrollment-events" }]);
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
    },
    approval: { state: "approved", operator: "Dardan", environment: "staging", releaseId: "staging-fixture", approvedAt: "2026-11-01T11:30:00Z" },
    migrations: { course: { state: "verified" }, community: { state: "verified" } },
    recovery: { state: "verified" },
    workload: { environment: "production", projectId: "prj_fixture" },
    scheduler: { state: "verified", cancellation: "verified" },
  };
  assert.deepEqual(validatePlatformRelease(release, now), []);
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
  assert.equal(builds.length, 5);
  for (const build of builds) {
    assert.ok(steps.indexOf(build) > verifyIndex);
    assert.match(build.with.context, /^https:\/\/github\.com\/princessdardan\/lash-her-/u);
    assert.equal(build.with.platforms, "linux/amd64");
    assert.equal(build.with.sbom, true);
    assert.equal(build.with.provenance, "mode=max");
    assert.equal(build["continue-on-error"], undefined);
  }
  const scans = steps.filter((step) => step.uses?.startsWith("aquasecurity/trivy-action@"));
  assert.equal(scans.length, 5);
  for (const scan of scans) {
    assert.ok(scan.with["image-ref"].includes("@${{"));
    assert.equal(scan.with["exit-code"], "1");
    assert.equal(scan.with.severity, "CRITICAL,HIGH");
    assert.equal(scan.with.version, "v0.76.1");
  }
  assert.ok(steps.some((step) => step.run?.includes("artifact-candidate.mjs --harness")));
  const harnessIndex = steps.findIndex((step) => step.run?.includes("local-harness.mjs"));
  const finalCheckIndex = steps.findIndex((step) => step.run?.includes("source-checks.final.json"));
  const qualificationIndex = steps.findIndex((step) => step.run?.includes("artifact-candidate.mjs --harness"));
  assert.ok(harnessIndex > verifyIndex && finalCheckIndex > harnessIndex && qualificationIndex > finalCheckIndex);
  assert.equal(workflow.on.workflow_dispatch.inputs.source_branch.default, "main");
  assert.ok(!JSON.stringify(workflow).includes("aws-actions/"));
});
