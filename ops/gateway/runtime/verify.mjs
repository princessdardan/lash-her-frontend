import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = value => /^[a-f0-9]{64}$/u.test(value ?? '');
const runtime = dirname(fileURLToPath(import.meta.url));

export function validateRuntimeEvidence({ lock, lockSha256, build, observed, image, scan, sbom }) {
  assert.equal(lock.version, 1);
  assert.equal(lock.upstreamCommit, 'df84af25dc1942490e1d1c899a07619152a46148');
  assert.deepEqual(lock.vulnerabilities, ['CVE-2026-76844', 'CVE-2026-85091']);
  assert.equal(build.inputsLockSha256, lockSha256);
  assert.deepEqual(build.inputs, lock);
  assert.deepEqual(observed.evidence, build);
  assert.deepEqual(build.regression, { unpatched: 'EXPECTED_ASSERTION_FAILURE', patched: 'PASS', shared: 'PASS', upstreamTests: 'PASS' });
  for (const name of ['librarySha256', 'regressionBinarySha256', 'packageSha256']) assert.ok(sha(build[name]));
  assert.equal(observed.librarySha256, build.librarySha256);
  assert.equal(observed.regressionBinarySha256, build.regressionBinarySha256);
  assert.equal(observed.regressionStatus, 0);
  assert.equal(observed.uid, 65532);
  assert.match(observed.packageStatus, /^Status: install ok installed$/mu);
  assert.match(observed.packageStatus, new RegExp(`^Version: ${lock.packageVersion.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'mu'));
  assert.equal(image.Os, 'linux');
  assert.equal(image.Architecture, observed.architecture);
  assert.equal(scan.Metadata.ImageID, image.Id);
  assert.equal(scan.Metadata.OS.Family, 'debian');
  assert.equal(scan.Metadata.OS.Name, '13.7');
  assert.ok(image.RepoDigests?.length && image.RepoDigests.some(d => scan.Metadata.RepoDigests?.includes(d)));
  const product = sbom.metadata.component.purl;
  assert.ok(product?.startsWith('pkg:oci/'));
  assert.ok(image.RepoDigests.some(d => decodeURIComponent(product).includes(d.split('@')[1])));
  const packages = sbom.components.filter(c => c.name === 'zlib1g');
  assert.equal(packages.length, 1);
  const pkg = packages[0];
  assert.equal(pkg.version, lock.packageVersion);
  assert.ok(pkg.purl?.startsWith('pkg:deb/debian/zlib1g@'));
  const scanned = (scan.Results ?? []).flatMap(r => r.Packages ?? []).filter(p => p.Name === 'zlib1g');
  assert.equal(scanned.length, 1);
  assert.equal(scanned[0].ID, `zlib1g@${lock.packageVersion}`);
  assert.equal(scanned[0].Identifier.PURL, pkg.purl);
  return { product, component: pkg.purl };
}

export function runtimeVex(binding, lock, timestamp = new Date().toISOString()) {
  return { '@context': 'https://openvex.dev/ns/v0.2.0', '@id': `https://lashher.ca/runtime-vex/${hash(JSON.stringify(binding))}`,
    author: 'Lash Her verified runtime build', timestamp, version: 1,
    statements: lock.vulnerabilities.map(name => ({ vulnerability: { name },
      products: [{ '@id': binding.product, subcomponents: [{ '@id': binding.component }] }],
      status: 'fixed', action_statement: `Verified Debian 1.3.1 backport of ${lock.upstreamCommit}; original failed-write regression fails, installed replacement passes.` })) };
}

export function validateQualifiedRuntimeScan({ lock, lockSha256, record, rawScan, sbom, vex, filteredScan, expectedImage }) {
  assert.equal(record.status, 'PATCHED_RUNTIME_VERIFIED');
  assert.equal(rawScan.ArtifactName, expectedImage);
  assert.equal(filteredScan.ArtifactName, expectedImage);
  assert.equal(filteredScan.Metadata.ImageID, record.image.Id);
  const binding = validateRuntimeEvidence({ lock, lockSha256, build: record.build, observed: record.observed,
    image: record.image, scan: rawScan, sbom });
  assert.deepEqual(record.binding, binding);
  assert.deepEqual(vex, runtimeVex(binding, lock, vex.timestamp));
  const isPatched = v => lock.vulnerabilities.includes(v.VulnerabilityID) && v.PkgName === 'zlib1g' &&
    v.InstalledVersion === lock.packageVersion && v.PkgIdentifier?.PURL === binding.component;
  for (const result of rawScan.Results) for (const v of result.Vulnerabilities ?? []) {
    if (['HIGH', 'CRITICAL'].includes(v.Severity)) assert.ok(isPatched(v), 'Unresolved image vulnerability');
  }
  for (const result of filteredScan.Results) {
    assert.equal((result.Vulnerabilities ?? []).some(v => ['HIGH', 'CRITICAL'].includes(v.Severity)), false);
    for (const change of result.ExperimentalModifiedFindings ?? []) {
      assert.equal(change.Type, 'vulnerability');
      assert.equal(change.Status, 'fixed');
      assert.ok(isPatched(change.Finding), 'Unsupported fixed statement');
    }
  }
  return binding;
}

export function verifyRecordedRuntime(directory, prefix, expectedImage, sourceDirectory) {
  const load = path => JSON.parse(readFileSync(path));
  const proofDirectory = join(directory, `${prefix}-runtime`);
  const record = load(join(proofDirectory, 'verification.json'));
  const rawPath = join(directory, `${prefix}-raw-scan.json`), sbomPath = join(proofDirectory, 'sbom.json');
  const vexPath = join(proofDirectory, 'fixed.vex.json'), scanPath = join(directory, `${prefix}-scan.json`);
  for (const [path, expected] of [[rawPath, record.rawScanSha256], [sbomPath, record.sbomSha256],
    [vexPath, record.vexSha256], [scanPath, record.scanSha256]]) assert.equal(hash(readFileSync(path)), expected);
  const lockBytes = readFileSync(join(sourceDirectory, 'ops/gateway/runtime/inputs.lock.json'));
  return validateQualifiedRuntimeScan({ lock: JSON.parse(lockBytes), lockSha256: hash(lockBytes), record,
    rawScan: load(rawPath), sbom: load(sbomPath), vex: load(vexPath), filteredScan: load(scanPath), expectedImage });
}

const imageProbe = String.raw`
const fs=require('node:fs'),crypto=require('node:crypto'),cp=require('node:child_process'),zlib=require('node:zlib');
const digest=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const evidence=JSON.parse(fs.readFileSync('/usr/share/lash-runtime/zlib.json'));
const libraryAlias=require('node:path').join(require('node:path').dirname(evidence.library),'libz.so.1');
if(fs.realpathSync(libraryAlias)!==evidence.library)process.exit(1);
const text='runtime compression smoke';if(zlib.gunzipSync(zlib.gzipSync(text)).toString()!==text)process.exit(1);
crypto.createHash('sha256').update(text).digest();require('node:tls').createSecureContext();
for(const p of ['/bin/sh','/bin/bash','/usr/bin/gcc','/usr/bin/make','/runtime'])if(fs.existsSync(p))process.exit(1);
const regression='/usr/libexec/lash-her/zlib-regression';
const r=cp.spawnSync(regression,[],{encoding:'utf8'});if(r.error||r.status!==0)process.exit(1);
console.log(JSON.stringify({evidence,librarySha256:digest(evidence.library),regressionBinarySha256:digest(regression),
 packageStatus:fs.readFileSync('/var/lib/dpkg/status.d/zlib1g','utf8'),regressionStatus:r.status,uid:process.getuid(),
 architecture:process.arch==='x64'?'amd64':process.arch==='arm64'?'arm64':process.arch}));
`;

export function verifyRuntimeImage({ imageRef, rawScan, output, execute = execFileSync }) {
  const run = (command, args) => execute(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const lockBytes = readFileSync(join(runtime, 'inputs.lock.json')), lock = JSON.parse(lockBytes);
  for (const [file, digest] of Object.entries({ ...lock.patches, ...lock.implementation })) assert.equal(hash(readFileSync(join(runtime, file))), digest);
  mkdirSync(output, { mode: 0o700 });
  // Build an independent reference from the reviewed source, never from the image being assessed.
  const reference = `lash-her-zlib-verification:${randomUUID()}`;
  let build;
  try {
    run('docker', ['build', '--platform', 'linux/' + JSON.parse(readFileSync(rawScan)).Metadata.ImageConfig.architecture,
      '--target', 'zlib-build', '-f', join(runtime, '../Dockerfile'), '-t', reference, join(runtime, '..')]);
    build = JSON.parse(run('docker', ['run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'cat', reference, '/out/evidence/zlib.json']));
  } finally { try { run('docker', ['image', 'rm', reference]); } catch { /* original failure remains authoritative */ } }
  let image;
  try { image = JSON.parse(run('docker', ['image', 'inspect', imageRef]))[0]; }
  catch { run('docker', ['pull', imageRef]); image = JSON.parse(run('docker', ['image', 'inspect', imageRef]))[0]; }
  const observed = JSON.parse(run('docker', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--entrypoint', 'node', image.Id, '-e', imageProbe]));
  const immutable = imageRef.includes('@sha256:') ? imageRef : image.RepoDigests[0];
  const sbomPath = join(output, 'sbom.json');
  run('trivy', ['image', '--format', 'cyclonedx', '--output', sbomPath, immutable]);
  const scan = JSON.parse(readFileSync(rawScan)), sbom = JSON.parse(readFileSync(sbomPath));
  const binding = validateRuntimeEvidence({ lock, lockSha256: hash(lockBytes), build, observed, image, scan, sbom });
  const vex = runtimeVex(binding, lock), vexPath = join(output, 'fixed.vex.json');
  writeFileSync(vexPath, JSON.stringify(vex, null, 2) + '\n', { flag: 'wx' });
  // Unknown or unrelated HIGH/CRITICAL findings retain their ordinary failing exit status.
  run('trivy', ['image', '--vex', vexPath, '--show-suppressed', '--severity', 'HIGH,CRITICAL', '--exit-code', '1',
    '--format', 'json', '--output', join(output, 'scan.json'), immutable]);
  const record = { version: 1, status: 'PATCHED_RUNTIME_VERIFIED',
    image: { Id: image.Id, RepoDigests: image.RepoDigests, Os: image.Os, Architecture: image.Architecture },
    binding, build, observed, rawScanSha256: hash(readFileSync(rawScan)), sbomSha256: hash(readFileSync(sbomPath)),
    vexSha256: hash(readFileSync(vexPath)), scanSha256: hash(readFileSync(join(output, 'scan.json'))) };
  // Also validate the raw/filtered finding correspondence before retaining qualification.
  validateQualifiedRuntimeScan({ lock, lockSha256: hash(lockBytes), record,
    rawScan: { ...scan, ArtifactName: immutable }, sbom, vex,
    filteredScan: JSON.parse(readFileSync(join(output, 'scan.json'))), expectedImage: immutable });
  writeFileSync(join(output, 'verification.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [imageRef, rawScan, output] = process.argv.slice(2);
    assert.equal(process.argv.length, 5);
    verifyRuntimeImage({ imageRef, rawScan, output });
  } catch { console.error('PATCHED_RUNTIME_VERIFICATION_FAILED'); process.exitCode = 1; }
}
