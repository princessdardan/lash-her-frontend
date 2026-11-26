import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = value => /^[a-f0-9]{64}$/u.test(value ?? '');
const runtime = dirname(fileURLToPath(import.meta.url));

function readNodeLock(directory) {
  const lock = JSON.parse(readFileSync(join(directory, 'node-inputs.lock.json')));
  // Historical source checkouts carry the original single-patch lock.
  const patches = lock.patches ?? { 'openssl-cve-2026-124709.patch': { sha256: lock.opensslPatchSha256 } };
  for (const [name, entry] of Object.entries(patches)) {
    assert.equal(hash(readFileSync(join(directory, name))), entry.sha256);
  }
  return lock;
}

function validatePatchedNode({ lock, observed, scan, sbom, nodeBuild }) {
  const { evidence, executableSha256, nodeVersion, opensslVersion, zstdVersion, sharedOpenSSL, sharedZstd, quic } = observed;
  assert.equal(evidence.version, 1);
  assert.deepEqual(evidence.inputs, lock);
  assert.ok(sha(executableSha256));
  assert.equal(executableSha256, evidence.nodeSha256, "NODE_PACKAGED_EXECUTABLE_MISMATCH");
  assert.equal(nodeVersion, `v${lock.nodeVersion}`);
  assert.equal(opensslVersion, lock.opensslVersion);
  assert.equal(sharedOpenSSL, false);
  assert.equal(quic, false);
  const packages = [...sbom.components.map(component => component.name),
    ...(scan.Results ?? []).flatMap(result => (result.Packages ?? []).map(pkg => pkg.Name))];
  assert.ok(!packages.some(name => /^libssl3(?:t64)?$/u.test(name)), 'Unexpected Debian OpenSSL runtime package');
  if (lock.patches) {
    assert.deepEqual(evidence, nodeBuild, "NODE_REFERENCE_RECEIPT_MISMATCH");
    assert.equal(zstdVersion, lock.zstdVersion);
    assert.equal(sharedZstd, false);
    assert.ok(!packages.includes('libzstd1'), 'Unexpected Debian Zstandard runtime package');
  }
}

export function validateRuntimeEvidence({ lock, lockSha256, build, observed, image, scan, sbom, nodeLock, nodeBuild }) {
  assert.equal(lock.version, 1);
  assert.equal(lock.upstreamCommit, 'df84af25dc1942490e1d1c899a07619152a46148');
  assert.deepEqual(lock.vulnerabilities, ['CVE-2026-76844', 'CVE-2026-85091']);
  assert.equal(build.inputsLockSha256, lockSha256);
  assert.deepEqual(build.inputs, lock);
  assert.deepEqual(observed.evidence, build, "ZLIB_REFERENCE_RECEIPT_MISMATCH");
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
  if (nodeLock) validatePatchedNode({ lock: nodeLock, observed: observed.nodeRuntime, scan, sbom, nodeBuild });
  return { product, component: pkg.purl };
}

export function runtimeVex(binding, lock, timestamp = new Date().toISOString()) {
  return { '@context': 'https://openvex.dev/ns/v0.2.0', '@id': `https://lashher.ca/runtime-vex/${hash(JSON.stringify(binding))}`,
    author: 'Lash Her verified runtime build', timestamp, version: 1,
    statements: lock.vulnerabilities.map(name => ({ vulnerability: { name },
      products: [{ '@id': binding.product, subcomponents: [{ '@id': binding.component }] }],
      status: 'fixed', action_statement: `Verified Debian 1.3.1 backport of ${lock.upstreamCommit}; original failed-write regression fails, installed replacement passes.` })) };
}

export function validateQualifiedRuntimeScan({ lock, lockSha256, record, rawScan, sbom, vex, filteredScan, expectedImage, nodeLock }) {
  assert.equal(record.status, 'PATCHED_RUNTIME_VERIFIED');
  assert.equal(rawScan.ArtifactName, expectedImage);
  assert.equal(filteredScan.ArtifactName, expectedImage);
  assert.equal(filteredScan.Metadata.ImageID, record.image.Id);
  const binding = validateRuntimeEvidence({ lock, lockSha256, build: record.build, observed: record.observed,
    image: record.image, scan: rawScan, sbom, nodeLock, nodeBuild: record.nodeBuild });
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
  const nodeLockPath = join(sourceDirectory, 'ops/gateway/runtime/node-inputs.lock.json');
  const nodeLock = existsSync(nodeLockPath) ? readNodeLock(dirname(nodeLockPath)) : undefined;
  return validateQualifiedRuntimeScan({ nodeLock, lock: JSON.parse(lockBytes), lockSha256: hash(lockBytes), record,
    rawScan: load(rawPath), sbom: load(sbomPath), vex: load(vexPath), filteredScan: load(scanPath), expectedImage });
}

const imageProbe = String.raw`
const fs=require('node:fs'),crypto=require('node:crypto'),cp=require('node:child_process'),zlib=require('node:zlib');
const digest=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const evidence=JSON.parse(fs.readFileSync('/usr/share/lash-runtime/zlib.json'));
const nodeEvidence=JSON.parse(fs.readFileSync('/usr/share/lash-runtime/node.json'));
const libdir=require('node:path').dirname(evidence.library);
for(const dir of new Set([libdir,'/usr/lib','/nodejs/lib','/var/lib/dpkg/status.d'])) {
  if(fs.existsSync(dir)&&fs.readdirSync(dir).some(name=>/^lib(?:(?:ssl|crypto)(?:3|\.so)|zstd(?:1|\.so))/u.test(name)))process.exit(1);
}
const nodeRuntime={evidence:nodeEvidence,executableSha256:digest(process.execPath),
 nodeVersion:process.version,opensslVersion:process.versions.openssl,zstdVersion:process.versions.zstd,
 sharedOpenSSL:process.config.variables.node_shared_openssl,sharedZstd:process.config.variables.node_shared_zstd,quic:process.features.quic};
const libraryAlias=require('node:path').join(require('node:path').dirname(evidence.library),'libz.so.1');
if(fs.realpathSync(libraryAlias)!==evidence.library)process.exit(1);
const text='runtime compression smoke';if(zlib.gunzipSync(zlib.gzipSync(text)).toString()!==text)process.exit(1);
if(zlib.zstdDecompressSync(zlib.zstdCompressSync(text)).toString()!==text)process.exit(1);
crypto.createHash('sha256').update(text).digest();require('node:tls').createSecureContext();
for(const p of ['/bin/sh','/bin/bash','/usr/bin/gcc','/usr/bin/make','/runtime'])if(fs.existsSync(p))process.exit(1);
const regression='/usr/libexec/lash-her/zlib-regression';
const r=cp.spawnSync(regression,[],{encoding:'utf8'});if(r.error||r.status!==0)process.exit(1);
console.log(JSON.stringify({evidence,librarySha256:digest(evidence.library),regressionBinarySha256:digest(regression),
 packageStatus:fs.readFileSync('/var/lib/dpkg/status.d/zlib1g','utf8'),regressionStatus:r.status,nodeRuntime,uid:process.getuid(),
 architecture:process.arch==='x64'?'amd64':process.arch==='arm64'?'arm64':process.arch}));
`;

export function verifyRuntimeImage({ imageRef, rawScan, output, migration = false, execute = execFileSync }) {
  const run = (command, args) => execute(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const lockBytes = readFileSync(join(runtime, 'inputs.lock.json')), lock = JSON.parse(lockBytes);
  const nodeLock = readNodeLock(runtime);
  for (const [file, digest] of Object.entries({ ...lock.patches, ...lock.implementation })) assert.equal(hash(readFileSync(join(runtime, file))), digest);
  mkdirSync(output, { mode: 0o700 });
  const platform = 'linux/' + JSON.parse(readFileSync(rawScan)).Metadata.ImageConfig.architecture;
  const context = migration ? join(runtime, '../../..') : join(runtime, '..');
  const recipe = migration ? ['-f', join(context, 'ops/platform/Dockerfile.frontend-migration')] : [];
  const zlibReference = `lash-her-zlib-verification:${randomUUID()}`;
  let build;
  try {
    run('docker', ['buildx', 'build', '--load', '--platform', platform,
      '--target', 'zlib-build', ...recipe, '-t', zlibReference, context]);
    build = JSON.parse(run('docker', ['run', '--rm', '--network', 'none', '--read-only',
      '--entrypoint', 'cat', zlibReference, '/out/evidence/zlib.json']));
  } finally { try { run('docker', ['image', 'rm', zlibReference]); } catch { /* original failure remains authoritative */ } }
  const nodeReference = mkdtempSync(join(output, 'node-reference-'));
  let nodeBuild;
  try {
    // Export the small receipt from the same Buildx stage used for the candidate.
    run('docker', ['buildx', 'build', '--platform', platform, '--target', 'node-reference', ...recipe,
      '--output', `type=local,dest=${nodeReference}`, context]);
    nodeBuild = JSON.parse(readFileSync(join(nodeReference, 'node.json')));
  } finally { rmSync(nodeReference, { recursive: true, force: true }); }
  let image;
  try { image = JSON.parse(run('docker', ['image', 'inspect', imageRef]))[0]; }
  catch { run('docker', ['pull', imageRef]); image = JSON.parse(run('docker', ['image', 'inspect', imageRef]))[0]; }
  const observed = JSON.parse(run('docker', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--entrypoint', 'node', image.Id, '-e', imageProbe]));
  const immutable = imageRef.includes('@sha256:') ? imageRef : image.RepoDigests[0];
  const sbomPath = join(output, 'sbom.json');
  run('trivy', ['image', '--format', 'cyclonedx', '--output', sbomPath, immutable]);
  const scan = JSON.parse(readFileSync(rawScan)), sbom = JSON.parse(readFileSync(sbomPath));
  const binding = validateRuntimeEvidence({ lock, lockSha256: hash(lockBytes), build, observed, image, scan, sbom, nodeLock, nodeBuild });
  const vex = runtimeVex(binding, lock), vexPath = join(output, 'fixed.vex.json');
  writeFileSync(vexPath, JSON.stringify(vex, null, 2) + '\n', { flag: 'wx' });
  // Unknown or unrelated HIGH/CRITICAL findings retain their ordinary failing exit status.
  run('trivy', ['image', '--vex', vexPath, '--show-suppressed', '--severity', 'HIGH,CRITICAL', '--exit-code', '1',
    '--format', 'json', '--output', join(output, 'scan.json'), immutable]);
  const record = { version: 1, status: 'PATCHED_RUNTIME_VERIFIED',
    image: { Id: image.Id, RepoDigests: image.RepoDigests, Os: image.Os, Architecture: image.Architecture },
    binding, build, nodeBuild, observed, rawScanSha256: hash(readFileSync(rawScan)), sbomSha256: hash(readFileSync(sbomPath)),
    vexSha256: hash(readFileSync(vexPath)), scanSha256: hash(readFileSync(join(output, 'scan.json'))) };
  // Also validate the raw/filtered finding correspondence before retaining qualification.
  validateQualifiedRuntimeScan({ nodeLock, lock, lockSha256: hash(lockBytes), record,
    rawScan: { ...scan, ArtifactName: immutable }, sbom, vex,
    filteredScan: JSON.parse(readFileSync(join(output, 'scan.json'))), expectedImage: immutable });
  writeFileSync(join(output, 'verification.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
}

export function runtimeFailure(error) {
  const reasons = ["NODE_PACKAGED_EXECUTABLE_MISMATCH", "NODE_REFERENCE_RECEIPT_MISMATCH", "ZLIB_REFERENCE_RECEIPT_MISMATCH"];
  if (!reasons.includes(error?.message)) return { reason: "RUNTIME_EVIDENCE_OR_SCAN_REFUSED" };
  const reason = error.message;
  if (sha(error.actual) && sha(error.expected)) return { reason, candidate: error.actual, reference: error.expected };
  for (const field of ["nodeSha256", "librarySha256", "regressionBinarySha256", "packageSha256"]) {
    const candidate = error.actual?.[field], reference = error.expected?.[field];
    if (sha(candidate) && sha(reference) && candidate !== reference) return { reason, field, candidate, reference };
  }
  return { reason };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [imageRef, rawScan, output] = process.argv.slice(2);
    assert.equal(process.argv.length, 5);
    verifyRuntimeImage({ imageRef, rawScan, output, migration: process.env.FRONTEND_RUNTIME_IMAGE === 'migration' });
  } catch (error) {
    console.error('PATCHED_RUNTIME_VERIFICATION_FAILED', JSON.stringify(runtimeFailure(error)));
    process.exitCode = 1;
  }
}
