# P1-02 candidate .3 release attempt

Candidate `.3` could not pass the current mandatory dependency audit. Protected
migration verification, staging promotion and the authorized retention invocation
were not executed. P1-02 remains **BLOCKED**.

The immutable revision is `6cce23a6e28a6b43ac5043986b421db7a2e80827`.
The exact protected expected-revision variable was updated and the allowed
`codex/p1-02-staging-release` branch advanced to this revision. The
[release workflow](https://github.com/princessdardan/lash-her-frontend/actions/runs/40130648351)
failed its audit with 6 high, 2 moderate and 1 low findings, including Undici and
Zod. The prior successful CI remains historical evidence; it cannot satisfy this
current release gate. The audit and immutable candidate tag were not changed.

Staging remains on `d915619`, deployment `dpl_BCyvMh81J8KyGFuas3pJgNCKUkys`.
Both protected Vercel release pins remain there. All-deployment protection and
disabled shipping/HighLevel flags were verified. No provider subscriptions or
credentials were changed. Manual retention attempt count is zero.

[Machine-readable evidence and gate register](2026-10-24-p1-02-candidate-3-release-attempt.json)
retain A01-A07/R01-R04 and add R05 for the current audit blocker. A01/A07 remain
source fixed with deployed verification pending. A dependency-fix replacement
requires a new immutable candidate; it must pass full CI and the protected
migration job before source/migration pins and staging can advance. The approved
single retention invocation remains unexecuted.
