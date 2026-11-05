import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { validateRuntimeEvidence, runtimeVex, verifyRuntimeImage, validateQualifiedRuntimeScan } from '../gateway/runtime/verify.mjs';

const lockBytes = readFileSync(new URL('../gateway/runtime/inputs.lock.json', import.meta.url));
const lock = JSON.parse(lockBytes), digest = 'a'.repeat(64);
const id = `sha256:${digest}`, ref = `example.invalid/runtime@${id}`;
const product = `pkg:oci/runtime@sha256%3A${digest}?arch=amd64&repository_url=example.invalid%2Fruntime`;
const component = `pkg:deb/debian/zlib1g@${encodeURIComponent(lock.packageVersion)}?arch=amd64&distro=debian-13.7`;
function fixture() {
  const build = { inputsLockSha256: createHash('sha256').update(lockBytes).digest('hex'), inputs: structuredClone(lock),
    librarySha256: digest, packageSha256: digest, regressionBinarySha256: digest,
    regression: { unpatched: 'EXPECTED_ASSERTION_FAILURE', patched: 'PASS', shared: 'PASS', upstreamTests: 'PASS' } };
  return { lock: structuredClone(lock), lockSha256: build.inputsLockSha256, build,
    observed: { evidence: structuredClone(build), librarySha256: digest, regressionBinarySha256: digest,
      regressionStatus: 0, uid: 65532, architecture: 'amd64', packageStatus: `Status: install ok installed\nVersion: ${lock.packageVersion}\n` },
    image: { Id: id, RepoDigests: [ref], Architecture: 'amd64', Os: 'linux' },
    scan: { Metadata: { ImageID: id, RepoDigests: [ref], OS: { Family: 'debian', Name: '13.7' } },
      Results: [{ Packages: [{ Name: 'zlib1g', ID: `zlib1g@${lock.packageVersion}`, Identifier: { PURL: component } }] }] },
    sbom: { metadata: { component: { purl: product } }, components: [{ name: 'zlib1g', version: lock.packageVersion, purl: component }] } };
}

test('runtime fixed statements bind the proven image and exact custom package only', () => {
  const binding = validateRuntimeEvidence(fixture());
  assert.deepEqual(binding, { product, component });
  const vex = runtimeVex(binding, lock, '2026-11-05T00:00:00.000Z');
  assert.deepEqual(vex.statements.map(s => s.vulnerability.name), lock.vulnerabilities);
  for (const s of vex.statements) {
    assert.equal(s.status, 'fixed');
    assert.deepEqual(s.products, [{ '@id': product, subcomponents: [{ '@id': component }] }]);
  }
});

for (const [name, change] of Object.entries({
  'changed library': f => { f.observed.librarySha256 = 'b'.repeat(64); },
  'changed test executable': f => { f.observed.regressionBinarySha256 = 'b'.repeat(64); },
  'missing backport': f => { delete f.build.inputs.patches['backport.patch']; },
  'changed source': f => { f.build.inputs.upstreamCommit = 'b'.repeat(40); },
  'stale reference build': f => { f.build.inputsLockSha256 = 'b'.repeat(64); },
  'unrelated image': f => { f.scan.Metadata.ImageID = `sha256:${'b'.repeat(64)}`; },
  'unrelated digest': f => { f.scan.Metadata.RepoDigests = ['other@sha256:' + 'b'.repeat(64)]; },
  'unrelated SBOM': f => { f.sbom.metadata.component.purl = 'pkg:oci/other@sha256:' + 'b'.repeat(64); },
  'unrelated package': f => { f.sbom.components[0].name = 'other'; },
  'original package': f => { f.scan.Results[0].Packages[0].ID = 'zlib1g@1:1.3.dfsg+really1.3.1-1+b1'; },
  'missing negative control': f => { f.build.regression.unpatched = 'PASS'; },
  'failed regression': f => { f.observed.regressionStatus = 134; },
  'unsupported CVE': f => { f.lock.vulnerabilities.push('CVE-2099-9999'); },
  'root runtime': f => { f.observed.uid = 0; },
})) test(`runtime verification refuses ${name}`, () => {
  const f = fixture(); change(f);
  assert.throws(() => validateRuntimeEvidence(f));
});

test('build inputs and patches remain bound to the reviewed lock', () => {
  for (const [file, expected] of Object.entries({ ...lock.patches, ...lock.implementation })) {
    assert.equal(createHash('sha256').update(readFileSync(new URL(`../gateway/runtime/${file}`, import.meta.url))).digest('hex'), expected);
  }
});

test('an unresolved HIGH finding still fails the verified-runtime scan', () => {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-gate-'));
  const f = fixture(), raw = join(directory, 'raw.json'), output = join(directory, 'verified');
  writeFileSync(raw, JSON.stringify({ ...f.scan, Metadata: { ...f.scan.Metadata, ImageConfig: { architecture: 'amd64' } } }));
  let gated = false;
  const execute = (command, args) => {
    if (command === 'docker') {
      if (args.includes('inspect')) return JSON.stringify([f.image]);
      if (args.includes('cat')) return JSON.stringify(f.build);
      if (args.includes('node')) return JSON.stringify(f.observed);
      return '';
    }
    assert.equal(command, 'trivy');
    if (args.includes('cyclonedx')) {
      writeFileSync(args[args.indexOf('--output') + 1], JSON.stringify(f.sbom));
      return '';
    }
    assert.equal(args[args.indexOf('--exit-code') + 1], '1');
    assert.equal(args[args.indexOf('--severity') + 1], 'HIGH,CRITICAL');
    assert.equal(args.includes('--ignore-unfixed'), false);
    gated = true;
    throw new Error('UNRESOLVED_HIGH_FINDING');
  };
  try {
    assert.throws(() => verifyRuntimeImage({ imageRef: ref, rawScan: raw, output, execute }), /UNRESOLVED_HIGH_FINDING/);
    assert.equal(gated, true);
    assert.equal(JSON.parse(readFileSync(join(output, 'fixed.vex.json'))).statements.length, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function qualified() {
  const f = fixture(), binding = validateRuntimeEvidence(f);
  const finding = { VulnerabilityID: 'CVE-2026-76844', PkgName: 'zlib1g', InstalledVersion: lock.packageVersion,
    PkgIdentifier: { PURL: component }, Severity: 'HIGH' };
  const rawScan = { ...f.scan, ArtifactName: ref,
    Results: [{ ...f.scan.Results[0], Vulnerabilities: [finding] }] };
  return { lock: f.lock, lockSha256: f.lockSha256, expectedImage: ref, sbom: f.sbom,
    record: { status: 'PATCHED_RUNTIME_VERIFIED', image: f.image, build: f.build, observed: f.observed, binding },
    rawScan, vex: runtimeVex(binding, lock), filteredScan: { ...rawScan,
      Results: [{ ExperimentalModifiedFindings: [{ Type: 'vulnerability', Status: 'fixed', Finding: finding }] }] } };
}

test('candidate qualification accepts only the exact verified fixed package', () => {
  assert.deepEqual(validateQualifiedRuntimeScan(qualified()), { product, component });
});
for (const [name, change] of Object.entries({
  'unrelated raw HIGH finding': f => { f.rawScan.Results[0].Vulnerabilities.push({ VulnerabilityID: 'CVE-2099-9999', Severity: 'HIGH' }); },
  'unresolved filtered finding': f => { f.filteredScan.Results[0].Vulnerabilities = [{ Severity: 'CRITICAL' }]; },
  'unproven filtered package': f => { f.filteredScan.Results[0].ExperimentalModifiedFindings[0].Finding.PkgName = 'other'; },
  'not affected assertion': f => { f.filteredScan.Results[0].ExperimentalModifiedFindings[0].Status = 'not_affected'; },
  'missing successful qualification': f => { delete f.record.status; },
  'changed VEX': f => { f.vex.statements[0].status = 'not_affected'; },
  'different published digest': f => { f.expectedImage = 'other@sha256:' + 'b'.repeat(64); },
})) test(`candidate qualification refuses ${name}`, () => {
  const f = qualified(); change(f);
  assert.throws(() => validateQualifiedRuntimeScan(f));
});
