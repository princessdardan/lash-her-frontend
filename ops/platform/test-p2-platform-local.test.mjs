import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { P2_OWNED_FIXTURES, p2OwnedFixtureEnvironment, validateP2FixtureReceipt, p2OwnedFixtureFailure } from './test-p2-platform-local.mjs';

function receipt(fixture, major = 18) {
  const common = { status: fixture.status, postgresMajor: major, providerTouched: false, checks: [...fixture.required] };
  if (fixture.id === 'roles') return { ...common, fixtureOnly: true, skipped: 0, actualTls: true, actualScram: true,
    actualFlockContention: true, actualPhysicalLockContention: true, executedChecks: common.checks.length, migrationAuthorized: false };
  if (fixture.id === 'release') return { ...common, liveAdapterQualified: false, migrationAuthorized: false, trafficAuthorized: false };
  if (fixture.id === 'certification') return { version: 1, status: common.status, serverMajor: major, frontendMigrations: 83, checks: common.checks,
    skipped: 0, actualTlsPostgres: true, noSqlReplay: true, providerTouched: false, actualHostDocker: false,
    browserQualified: false, nativeInvocationQualified: false, fixtureOnly: true };
  return { ...common, fixtureOnly: true, skipped: 0, executedChecks: common.checks.length, actualTlsPostgres: true, actualTlsReceivers: true,
    actualAppCron: true, actualRuntimeTrace: true, actualProvider: false, actualVercelNativeEvidence: false, modeledProviderNativeClassification: true,
    result: { status: 'P2_LIFECYCLE_NATIVE_QUALIFIED_FENCED', nativeEnabled: false,
      finalAdmission: { newWork: false, recovery: false, active: 0, uncertain: 0 } } };
}

test('fixed child environment removes ambient URLs, provider credentials, loader hooks and other owned flags', () => {
  const ambient = { PATH: '/owned/bin', HOME: '/owned/home', LANG: 'C', TMPDIR: '/owned/tmp', PG_BIN: '/owned/postgres/bin',
    DATABASE_URL: 'must-not-reach-child', TEST_DATABASE_URL: 'must-not-reach-child', VERCEL_TOKEN: 'must-not-reach-child',
    NODE_OPTIONS: '--import /unreviewed.mjs', NODE_EXTRA_CA_CERTS: '/unreviewed-ca', GIT_CONFIG_GLOBAL: '/unreviewed-config',
    FRONTEND_RELEASE_LOCAL_TEST: 'false', P2_NATIVE_OWNED_TEST: 'false', P2_PLATFORM_OWNED_TEST: 'true', OWNED_POSTGRES_MAJOR: '99' };
  for (const fixture of P2_OWNED_FIXTURES) {
    const environment = p2OwnedFixtureEnvironment(ambient, fixture, 18);
    assert.deepEqual(Object.keys(environment).sort(), ['PATH', 'HOME', 'LANG', 'TMPDIR', 'PG_BIN', 'OWNED_POSTGRES_MAJOR', fixture.flag].sort());
    assert.equal(environment[fixture.flag], 'true'); assert.equal(environment.OWNED_POSTGRES_MAJOR, '18');
    assert.equal(JSON.stringify(environment).includes('must-not-reach-child'), false);
  }
  assert.throws(() => p2OwnedFixtureEnvironment(ambient, { ...P2_OWNED_FIXTURES[0], file: 'arbitrary.mjs' }, 18));
  assert.throws(() => p2OwnedFixtureEnvironment({ ...ambient, PG_BIN: 'relative/bin' }, P2_OWNED_FIXTURES[0], 18));
});

test('receipt must prove the selected actual major, every required physical scenario and zero skips', () => {
  for (const fixture of P2_OWNED_FIXTURES) {
    const actual = receipt(fixture);
    assert.equal(validateP2FixtureReceipt(fixture, actual, 18).executedChecks, fixture.required.length);
    for (const changed of [null, {}, { ...actual, [fixture.id === 'certification' ? 'serverMajor' : 'postgresMajor']: 16 }, { ...actual, skipped: 1 },
      { ...actual, checks: [] }, { ...actual, checks: actual.checks.slice(1) },
      { ...actual, checks: [...actual.checks, actual.checks[0]] }, { ...actual, providerTouched: true }]) {
      assert.throws(() => validateP2FixtureReceipt(fixture, changed, 18));
    }
  }
});

test('certification fixture requires all ten current/physical cases and cannot claim deployed qualification', () => {
  const fixture = P2_OWNED_FIXTURES.find(value => value.id === 'certification'), actual = receipt(fixture);
  for (const change of [value => { value.frontendMigrations = 82; }, value => { value.actualTlsPostgres = false; },
    value => { value.noSqlReplay = false; }, value => { value.browserQualified = true; }, value => { value.nativeInvocationQualified = true; },
    value => { value.actualHostDocker = true; }, value => { value.postgresMajor = 18; }, value => { value.checks.reverse(); }]) {
    const changed = structuredClone(actual); change(changed); assert.throws(() => validateP2FixtureReceipt(fixture, changed, 18));
  }
});

test('strict certification consumer accepts actual retained PG18 ten-case receipt and refuses either missing new case', () => {
  const fixture=P2_OWNED_FIXTURES.find(value=>value.id==='certification');
  const actual=JSON.parse(readFileSync(new URL('../../docs/api-integration/baselines/2026-11-06-p2-known-ack-control/owned-current-postgres18.json',import.meta.url)));
  assert.equal(validateP2FixtureReceipt(fixture,actual,18).executedChecks,10);
  for(const missing of ['actual-fixed-direct-worker-epoch-original-operation-window-and-uncertainty-refusal',
    'actual-known-ack-epochs-exact-uncertainty-and-specific-operation-settlement']){
    assert.throws(()=>validateP2FixtureReceipt(fixture,{...actual,checks:actual.checks.filter(value=>value!==missing)},18));
  }
  const originalNine=JSON.parse(readFileSync(new URL('../../docs/api-integration/baselines/2026-11-06-p2-direct-worker-parent-hooks/owned-postgres18.json',import.meta.url)));
  assert.equal(originalNine.checks.length,9);assert.throws(()=>validateP2FixtureReceipt(fixture,originalNine,18));
});

test('native success cannot substitute for an enabled schedule, unfinished ledger or modeled app path', () => {
  const fixture = P2_OWNED_FIXTURES[2], actual = receipt(fixture);
  for (const changed of [{ ...actual, actualAppCron: false }, { ...actual, actualRuntimeTrace: false },
    { ...actual, actualProvider: true }, { ...actual, actualVercelNativeEvidence: true },
    { ...actual, result: { ...actual.result, nativeEnabled: true } },
    { ...actual, result: { ...actual.result, finalAdmission: { ...actual.result.finalAdmission, uncertain: 1 } } },
    { ...actual, result: { ...actual.result, finalAdmission: { ...actual.result.finalAdmission, newWork: true } } }]) {
    assert.throws(() => validateP2FixtureReceipt(fixture, changed, 18));
  }
});

test('child failure preserves fixed status/phase/checkpoint without echoing messages, stack or credential fields', () => {
  const fixture = P2_OWNED_FIXTURES[1];
  const actual = p2OwnedFixtureFailure(fixture, { status: 1, signal: null,
    stdout: '', stderr: 'warning\n' + JSON.stringify({ status: 'FRONTEND_RELEASE_OWNED_POSTGRES_FAILED',
      phase: 'same-action-role-abort-blocked-query', failureCode: 'OWNED_CHECK_FAILED', checkpoint: 'session-close',
      message: 'must-not-echo-secret', password: 'must-not-echo-secret', frames: ['must-not-echo-secret'] }) });
  assert.deepEqual(actual.observedChildFailures, [{ status: 'FRONTEND_RELEASE_OWNED_POSTGRES_FAILED',
    phase: 'same-action-role-abort-blocked-query', failureCode: 'OWNED_CHECK_FAILED', checkpoint: 'session-close' }]);
  assert.equal(JSON.stringify(actual).includes('must-not-echo-secret'), false);
  assert.deepEqual(p2OwnedFixtureFailure(fixture, { status: 0, stdout: '', stderr: '' }).observedChildFailures, []);
  assert.deepEqual(p2OwnedFixtureFailure(fixture, { status: 1, stdout: '', stderr: JSON.stringify({ status: 'UNREVIEWED_SECRET_VALUE', phase: 'secret-value' }) }).observedChildFailures, []);
});

test('wrapper rejects arbitrary arguments before running a PostgreSQL or fixture program', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./test-p2-platform-local.mjs', import.meta.url)), '--skip-native'], {
    env: { PATH: process.env.PATH, P2_PLATFORM_OWNED_TEST: 'true', OWNED_POSTGRES_MAJOR: '18', PG_BIN: '/must/not/execute' }, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).phase, 'fixed-wrapper-preflight');
});
