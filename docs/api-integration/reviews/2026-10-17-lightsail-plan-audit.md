# Lightsail / Vercel OIDC plan audit

Reviewed 2026-10-17, America/Toronto. Scope: the working-tree plans in all three
repositories, ENV-01e, environment worksheet, execution/prerequisite records,
related Course security documents, and the existing code paths affected by the
new topology. This is a design and integration audit, not a deployed security
assessment or capacity certification.

**Follow-up:** The [audit remediation record](../decisions/2026-10-17-audit-remediation.md)
tracks the user's subsequent instructions. A2/A3 now have local code corrections;
gateway/deployment verification remains outstanding. Dardan subsequently accepted
A1's dedicated-project Production target and APP_ENV separation as ENV-02-01;
implementation, provider mapping and deployment remain outstanding. The findings and
hash below preserve the original review snapshot.

## Verdict and decision status

**Conditionally viable for the intended launch of 50–100 registered users.**
Retain the selected topology while resolving the findings below. No evidence in
this review requires restoring paid Vercel Static IPs or moving the frontend and
databases to AWS. Registered users do not establish concurrency, request rate,
media workload or memory requirements.

ENV-01e remains the accepted planning decision. The 4 GB instance remains a test
candidate, not certified capacity or an approved total budget. This audit records
recommendations; it does not accept new business decisions, close gates, authorize
purchases or change runtime behavior. P1-02 remains blocked and subsequent
implementation/deployed verification remains outstanding.

The three `API-INTEGRATION-PLAN.md` copies were byte-for-byte identical at review:
SHA-256 `600ac68d119bd2e556573fb7b83e41eadb1ca7eccc9f93050bbc85ae135992ee`.

## Findings requiring resolution

### A1 — Specify a staging deployment target compatible with environment safeguards and scheduling

**Priority: P1; design integration gap. Owner: FE + OPS. Gates: P1-02/P1-03/P1-07.**

[ENV-01e](../decisions/2026-10-17-lightsail-ingress.md), lines 99–105, selects a
dedicated staging Vercel project but leaves the deployment environment claim for
inventory. A project's production deployment still has `VERCEL_ENV=production`,
even when that project serves the business staging environment.

The current frontend couples business safeguards to that platform value:

- [Sanity validation](../../../scripts/validate-sanity-env.mjs), lines 7–10 and
  147–153, requires the production dataset for a production deployment; using the
  isolated staging dataset fails the build.
- [Shipping configuration](../../../src/lib/shipping/config.ts), lines 131–137,
  rejects the Chit Chats staging environment when `VERCEL_ENV=production`.
- Selecting a controlled preview deployment avoids those particular production
  checks, but native Vercel Cron invokes the project's production deployment URL.
  It does not automatically exercise that preview. See
  [Vercel Cron behavior](https://vercel.com/docs/cron-jobs).

**Required resolution:** select and document the exact project/target/provider
mapping and scheduled-test strategy. If staging uses the project's production
target, separate the business environment from Vercel's deployment target with
validated configuration and retain fail-closed production safeguards. If staging
uses a controlled preview, specify how authenticated scheduled flows are tested.
Do not resolve the mismatch by giving staging live provider settings or spoofing
Vercel's platform environment variable.

**Acceptance:** staging builds against isolated data/providers; production still
rejects staging configuration; server-request and scheduled smoke calls carry the
expected OIDC claims; unrelated previews cannot authenticate to either gateway.

### A2 — Reconcile API rate-limit identity with the gateway's private peer address

**Priority: P1; confirmed integration hazard. Owner: COURSE + COMMUNITY + OPS.
Gates: P1-03/P1-04, then P6-03.**

Course `src/app.ts:118` and Community `src/app.ts:75` register a global limit of
120 requests per minute without a custom key generator. The installed plugin
defaults to `request.ip`, consistent with
[Fastify rate-limit documentation](https://github.com/fastify/fastify-rate-limit).
ENV-01e lines 146–153 intentionally preserve the gateway/private proxy peer in
that field for backend source checks.

Consequently, traffic through one gateway peer shares a single bucket in each
API for routes using the global limiter. Gateway per-principal quotas alone do
not remove this backend ceiling. Health/readiness can also share the bucket.
This can reject legitimate requests with only a few active users; it is not a
100-user capacity limit. Internal routes with explicit `rateLimit: false` and
their own controls are not included in this finding.

**Reproduction:** invoked each real `buildApp()` in test mode using `app.inject`,
without a database or listening socket. After 120 successful `/health` requests
from `172.22.0.2`, the next request and a `/ready` request from that peer were
rejected. A request from `172.22.0.3` succeeded. Course returned 429; Community
returned 500, explained by A3.

**Required resolution:** keep verified transport-peer checks separate from
application rate-limit identity. Define authenticated principal/route limits and
an intentional aggregate budget for public catalog traffic; isolate health checks
from user-traffic exhaustion. Do not trust arbitrary forwarded IP headers to
work around the problem. Ensure authentication has completed before using a
claimed principal as a quota key.

**Acceptance:** multiple principals behind one gateway do not exhaust each
other's ordinary allowance; aggregate abuse remains bounded; probes stay useful;
source allowlists still reject unauthorized peers after container recreation.

### A3 — Preserve the Community API's framework rate-limit status

**Priority: P2; confirmed existing code defect. Owner: COMMUNITY. Gate: P1-03.**

Community `src/http/errors.ts:46–77` recognizes its own `HttpError` and selected
Fastify errors, then converts remaining errors to a generic 500. The global
rate-limit plugin's rejection reaches that fallback.

The in-process reproduction returned 120 successful responses followed by
`500 / internal_error` instead of 429. This misclassifies throttling as a server
failure, affecting client behavior and operational signals. It predates this
documentation change but becomes more significant with A2.

**Required resolution:** explicitly map the known rate-limit error to a safe 429
response while preserving applicable retry headers. Keep unknown exceptions
sanitized as 500; do not expose arbitrary error messages/statuses.

**Acceptance:** a regression test verifies the actual plugin rejection, response
envelope and retry headers; a separate unexpected-error case remains a safe 500.

### A4 — Clarify the prerequisite register's historical completion section

**Priority: P3; documentation inconsistency. Owner: FE/OPS.**

[External prerequisites](../external-prerequisites.md), line 75, still says D-08,
D-01/D-06/D-07 are open and G0 requires P0-04. The authoritative
[execution tracker](../../../API-INTEGRATION-EXECUTION.md) records G0 complete
for the published baseline and resolved baseline dependencies.

Label that paragraph explicitly as the October 1 historical state or reconcile
it with the current tracker. Do not reopen completed baseline work. The new
Lightsail/OIDC sections and the three main plan copies are synchronized.

## Capacity, cost and operating conditions

1. **Measure sustained CPU as well as RAM and peak throughput.** AWS lists the
   proposed 4 GB bundle at US$24/month, and 8 GB at US$44/month, before tax/FX.
   The former has a 20% CPU baseline per vCPU: approximately 0.4 vCPU of aggregate
   sustained baseline across its two vCPUs, with accumulated capacity supporting
   bursts. The 8 GB bundle's baseline is 30% per vCPU. These are not two dedicated
   cores available indefinitely at full utilization.
   [Pricing](https://aws.amazon.com/lightsail/pricing/),
   [CPU baseline](https://docs.aws.amazon.com/en_en/lightsail/latest/userguide/baseline-cpu-performance.html).
   Add a sustained-load/burst-capacity check to P6-03; a 30-minute test alone can
   succeed on accumulated capacity. Measure all workers, media processing,
   polling, database connections and deployment overlap. Existing stress targets
   remain unchanged; record realistic launch traffic separately from certification
   stress traffic. Upgrade only when measurements justify it.
2. **Complete the staging shutdown/resume procedure.** The plan correctly
   requires a separate VM and explains deletion versus stopping for cost control.
   P1-07 should explicitly suspend staging schedules/test producers, account for
   provider webhook retries, drain or safely abandon leases, preserve durable
   state, and demonstrate replay/recovery after recreation. Otherwise the Vercel
   staging deployment can keep calling a backend that has been removed.
3. **Approve the complete cost and ownership model.** US$24 covers the production
   VM, not Vercel, three databases/PITR, temporary staging, snapshots, monitoring,
   media, notifications or payment-related services. The worksheet already lists
   these exclusions correctly. Assign a real operator and patch/recovery cadence;
   lower provider charges transfer work to that operator. No account-specific
   total or operator availability was verified.

## Controls that are adequately specified in the design

- OIDC workload verification is a viable replacement for the external source-IP
  requirement. Vercel documents custom API verification on all plans. Exact
  project/team/environment checks, pinned issuer/JWKS, time validation and key
  rotation are specified. Separate user/service authorization remains required.
  The plan correctly treats Function tokens as reusable bearer credentials and
  uses a dedicated header rather than replacing `Authorization`.
  [Custom API verification](https://vercel.com/docs/oidc/api),
  [claims](https://vercel.com/docs/oidc/reference),
  [token lifecycle](https://vercel.com/docs/oidc).
- The public route allowlist, narrowly signed Mux exception, unpublished API
  ports, IPv4/IPv6 checks, private TLS, source checks, header stripping and
  pre-authentication resource limits are explicit. Their implementation still
  needs deployed negative tests; documentation does not establish enforcement.
- Separate staging compute/data, immutable CI-built images, scoped secrets,
  container limits, off-host alerts, host recreation and independent database
  restores address the principal risks of this topology. Single-host downtime
  and the absence of high availability are explicitly acknowledged.

## Verification and limits

| Check performed | Result |
| --- | --- |
| Main-plan comparison across all three repositories | Identical SHA-256 above |
| `git diff --check` in all three repositories | Passed |
| Local link targets in tracked changed Markdown | No missing targets found |
| Frontend environment/shipping tests under Node 24.18.0 | 33 passed, zero failed |
| Course actual-app in-process limiter reproduction | 120 responses at 200, then 429; same-peer readiness 429; different peer 200 |
| Community actual-app in-process limiter reproduction | 120 responses at 200, then 500; same-peer readiness 500; different peer 200 |
| Current official AWS/Vercel documentation | Pricing, burst baseline, OIDC and cron assumptions checked |

Frontend test command:

```sh
node --conditions=react-server --import tsx --test --test-reporter=spec \
  src/lib/env/validate-sanity-env.test.ts src/lib/shipping/config.test.ts
```

Reproductions used `NODE_ENV=test` and `DOTENV_CONFIG_PATH=/dev/null` in a cleared
environment. They prove limiter behavior, not gateway behavior or host capacity.
The Community result confirms an unfixed defect, not a passing product check.

No full build/suite, live DB tests, provider inventory, deployed OIDC exchange,
firewall test, load test, restore rehearsal or dependency rescan was performed.
The existing D-09 dependency blocker is still recorded by the tracker; its
October 4 vulnerability count was not revalidated in this audit. No application
files, accepted decisions, task statuses or infrastructure were changed.
