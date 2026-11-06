// Fixed CI composition of disposable, source-owned PostgreSQL fixtures.
// No configured database URL, provider credential or alternate program is read.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const require = ok => { if (!ok) throw new Error('P2_PLATFORM_OWNED_FIXTURE_REFUSED'); };
const maximumOutput = 4_000_000;
const failureStatuses = new Set(['FRONTEND_ROLES_OWNED_FAILED', 'FRONTEND_RELEASE_OWNED_POSTGRES_FAILED',
  'OWNED_ROLE_COMPOSITION_DETAIL', 'P2_LIFECYCLE_NATIVE_OWNED_FAILED', 'P2_NATIVE_OWNED_CHILD_FAILED']);
export const P2_OWNED_FIXTURES = Object.freeze([
  Object.freeze({ id: 'roles', file: 'test-frontend-roles-local.mjs', flag: 'FRONTEND_ROLES_OWNED_TEST', status: 'FRONTEND_ROLES_OWNED_PASS', required: Object.freeze([
    'actual-environment-flock-contention-refuses-second-parent',
    'actual-physical-lock-contention-refuses-before-role-mutation',
    'real-postgres-assigned-oids-and-private-credential-retained',
    'actual-runtime-persistent-ddl-journal-and-membership-denied',
    'exact-approved-oid-grant-and-private-credential-reuse',
    'actual-commit-then-lost-ack-retains-unknown-and-private-recovery-material',
    'lost-commit-acknowledgment-is-never-replayed',
    'owned-server-logs-and-public-receipts-contain-no-password-or-scram-verifier',
  ]) }),
  Object.freeze({ id: 'release', file: 'test-frontend-release-local.mjs', flag: 'FRONTEND_RELEASE_LOCAL_TEST', status: 'FRONTEND_RELEASE_OWNED_POSTGRES_PASS', required: Object.freeze([
    'closed-bootstrap-real-login-retirement-migrations-compatible-http-promotion-and-held-controls',
    'actual-preapplication-schema-drift-refuses-before-bootstrap-build-and-sql',
    'actual-backend-death-during-bootstrap-stops-promotion-fencing-and-application-sql-with-closed-controls',
    'lost-bootstrap-promotion-response-retains-uncertainty-without-application-sql-replay-or-control-reopening',
    'actual-ledger-deferred-work-drains-before-reviewed-sql',
    'uncertain-never-expires-and-budget-refuses-before-sql-with-exclusive-replay-refusal',
    'missing-durable-database-receipt-retains-committed-sql-and-refuses-deployment',
    'actual-locked-backend-death-after-sql-stops-promotion-and-retains-closed-admission',
    'environment-lock-loss-fences-physical-client-and-refuses-promotion',
    'committed-sql-and-uncertain-promotion-preserved-with-new-read-only-recovery-action-and-no-replay',
    'p2-api-continuation-before-frontend-and-actual-tls-dual-pg-lock-observation-through-promotion-with-terminal-join',
    'p2-api-stage-actual-backend-death-preserves-committed-sql-and-prevents-frontend-mutation',
    'role-abort-during-actual-blocked-query-terminates-exact-backend-and-releases-pg-lock-before-rejection-under-held-environment-lock',
    'single-action-generated-role-credentials-and-observed-oids-feed-bootstrap-and-all-sql-on-the-same-held-physical-session',
  ]) }),
  Object.freeze({ id: 'native', file: 'test-p2-lifecycle-native-local.mjs', flag: 'P2_NATIVE_OWNED_TEST', status: 'P2_LIFECYCLE_NATIVE_OWNED_PASS', required: Object.freeze([
    'actual-physical-release-lock-contention',
    'actual-delayed-after-disable-request-is-fenced-after-closure-with-no-new-ledger-row-or-trace',
    'actual-postgres-barrier-update-interleaving-acknowledgements-refuse-before-native-enable',
    'actual-exported-cron-full-runtime-admission-context-and-opaque-trace',
    'actual-nonempty-and-empty-http-cron-invocations',
    'actual-course-community-https-service-jwt-idempotency-and-ordered-command-effects',
    'actual-event-uuid-source-producer-epoch-role-joins-completed-ledger',
    'actual-source-admission-closure-and-global-active-uncertain-zero',
    'private-credentials-not-in-common-evidence',
  ]) }),
]);

export function p2OwnedFixtureEnvironment(ambient, fixture, major) {
  require(P2_OWNED_FIXTURES.includes(fixture) && [16, 18].includes(major) &&
    typeof ambient.PG_BIN === 'string' && isAbsolute(ambient.PG_BIN) && resolve(ambient.PG_BIN) === ambient.PG_BIN);
  return Object.fromEntries([
    ...['PATH', 'HOME', 'LANG', 'TMPDIR'].filter(key => typeof ambient[key] === 'string').map(key => [key, ambient[key]]),
    ['PG_BIN', ambient.PG_BIN], ['OWNED_POSTGRES_MAJOR', String(major)], [fixture.flag, 'true'],
  ]);
}

export function validateP2FixtureReceipt(fixture, value, major) {
  require(P2_OWNED_FIXTURES.includes(fixture) && [16, 18].includes(major) && value && typeof value === 'object' && !Array.isArray(value) &&
    value.status === fixture.status && value.postgresMajor === major && value.providerTouched === false &&
    (value.skipped === undefined || value.skipped === 0) && Array.isArray(value.checks) && value.checks.length > 0 &&
    value.checks.every(check => typeof check === 'string' && /^[a-z0-9][a-z0-9-]{0,240}$/u.test(check)) &&
    new Set(value.checks).size === value.checks.length && fixture.required.every(check => value.checks.includes(check)));
  if (fixture.id === 'roles') require(value.fixtureOnly === true && value.skipped === 0 && value.actualTls === true &&
    value.actualScram === true && value.actualFlockContention === true && value.actualPhysicalLockContention === true &&
    value.executedChecks === value.checks.length && value.migrationAuthorized === false);
  if (fixture.id === 'release') require(value.liveAdapterQualified === false && value.migrationAuthorized === false && value.trafficAuthorized === false);
  if (fixture.id === 'native') require(value.fixtureOnly === true && value.skipped === 0 && value.executedChecks === value.checks.length &&
    value.actualTlsPostgres === true && value.actualTlsReceivers === true && value.actualAppCron === true &&
    value.actualRuntimeTrace === true && value.actualProvider === false && value.actualVercelNativeEvidence === false &&
    value.modeledProviderNativeClassification === true && value.result?.status === 'P2_LIFECYCLE_NATIVE_QUALIFIED_FENCED' &&
    value.result.nativeEnabled === false && value.result.finalAdmission?.newWork === false && value.result.finalAdmission.recovery === false &&
    value.result.finalAdmission.active === 0 && value.result.finalAdmission.uncertain === 0);
  return { id: fixture.id, status: value.status, postgresMajor: major, executedChecks: value.checks.length,
    skipped: 0, checks: [...value.checks], fixtureOnly: true, providerTouched: false };
}

function parsedFailure(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > maximumOutput) return [];
  try { return [JSON.parse(raw)]; } catch { /* Fixed children may report one JSON line after a warning. */ }
  return raw.split('\n').filter(line => line.startsWith('{') && line.endsWith('}')).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}
export function p2OwnedFixtureFailure(fixture, child) {
  require(P2_OWNED_FIXTURES.includes(fixture));
  const observed = [...parsedFailure(child.stdout), ...parsedFailure(child.stderr)].filter(value =>
    value && typeof value === 'object' && failureStatuses.has(value.status));
  const failures = observed.filter(value => !value.status.endsWith('_PASS')).map(value => Object.fromEntries(
    ['status', 'phase', 'failureCode', 'checkpoint'].filter(key => typeof value[key] === 'string' &&
      (key === 'status' || key === 'failureCode' ? /^[A-Z][A-Z0-9_]{0,100}$/u : /^[a-z][a-z0-9-]{0,100}$/u).test(value[key]))
      .map(key => [key, value[key]])));
  return { fixture: fixture.id, childExitCode: Number.isInteger(child.status) ? child.status : null,
    childSignal: ['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV'].includes(child.signal) ? child.signal : null,
    spawnFailureCode: ['ETIMEDOUT', 'ENOBUFS', 'ENOENT', 'EACCES'].includes(child.error?.code) ? child.error.code : null,
    observedChildFailures: failures.slice(-8) };
}

export function runP2PlatformOwned() {
  require(process.argv.length === 2 && process.env.P2_PLATFORM_OWNED_TEST === 'true' && process.versions.node.split('.')[0] === '24');
  const major = Number(process.env.OWNED_POSTGRES_MAJOR);
  require([16, 18].includes(major));
  const firstEnvironment = p2OwnedFixtureEnvironment(process.env, P2_OWNED_FIXTURES[0], major);
  const version = spawnSync(join(firstEnvironment.PG_BIN, 'postgres'), ['--version'], {
    cwd: root, env: firstEnvironment, encoding: 'utf8', timeout: 10_000, maxBuffer: 4096,
  });
  require(version.status === 0 && new RegExp(`PostgreSQL\\) ${major}\\.`, 'u').test(version.stdout));
  const summaries = [];
  for (const fixture of P2_OWNED_FIXTURES) {
    const program = join(root, 'ops/platform', fixture.file);
    const child = spawnSync(process.execPath, [program], { cwd: root,
      env: p2OwnedFixtureEnvironment(process.env, fixture, major), encoding: 'utf8', timeout: 240_000, maxBuffer: maximumOutput });
    let failureCode = 'P2_OWNED_CHILD_EXECUTION_FAILED';
    try {
      require(child.status === 0 && child.signal === null && !child.error && typeof child.stdout === 'string' && child.stdout.trim().length > 0);
      failureCode = 'P2_OWNED_CHILD_RECEIPT_INVALID';
      const summary = validateP2FixtureReceipt(fixture, JSON.parse(child.stdout), major);
      summaries.push({ ...summary, fixtureProgramSha256: hash(readFileSync(program)),
        stdoutSha256: hash(child.stdout), stderrSha256: hash(child.stderr ?? '') });
    } catch {
      return { status: 'P2_PLATFORM_OWNED_FAILED', fixtureOnly: true, postgresMajor: major, completed: summaries,
        failureCode, ...p2OwnedFixtureFailure(fixture, child), providerTouched: false, imagesQualified: false, releaseAccepted: false, g2Accepted: false };
    }
  }
  return { status: 'P2_PLATFORM_OWNED_PASS', fixtureOnly: true, postgresMajor: major, executedFixtures: summaries.length,
    skipped: 0, fixtures: summaries, providerTouched: false, imagesQualified: false, actualProviderNativeEvidence: false,
    releaseAccepted: false, g2Accepted: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = runP2PlatformOwned(); console.log(JSON.stringify(result));
    if (result.status !== 'P2_PLATFORM_OWNED_PASS') process.exitCode = 1;
  } catch {
    console.error(JSON.stringify({ status: 'P2_PLATFORM_OWNED_FAILED', phase: 'fixed-wrapper-preflight', fixtureOnly: true,
      providerTouched: false, imagesQualified: false, releaseAccepted: false, g2Accepted: false }));
    process.exitCode = 1;
  }
}
