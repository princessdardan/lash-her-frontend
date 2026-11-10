# Fault component correction qualification

Exact final component source: `68798e17ab3b52203582886987870b4615d8e83d`,
following `dd5fa1fc`. The original `ddde1654`/`a70b02bb` evidence is preserved;
this directory records the bounded correction and its independent review.

The host now requires the actual frontend receipt and source-computed target
hash on every verification, continuously checks gateway security/mounts, and
keeps the supplemental operator commit distinct from the immutable app commit.
The Node stage discards earlier cleanup facts after the final frontend ledger
read, then observes the current gateway/process/source/lease/counters, verifies
the full frontend configuration/feature/admission binding, and reads native
metadata last. Metadata-only fallback remains a review condition. Failed or
unknown containment never becomes release acceptance.

Node 24 passed 22 tests (10 gateway module, 12 stage), Python passed 10 host
tests, and focused lint passed. These include native re-enabling during the
final ledger read, gateway reopening after an earlier close, changed frontend
configuration/flags/writer binding, missing frontend proof, wrong target, and
supplemental operator identity. Both independently reproduced stale-read
failures now return `REQUIRES_REVIEW` with factual current state. An independent
review reran the same 22 Node and 10 Python cases and cleared this exact commit.

This is component qualification. It contains no joined PostgreSQL/remote Linux
Docker/source-parent execution, actual worker fault, provider retry, live native
invocation, or staging release evidence. The gateway's retained uncertainty
counter cannot be reset or ignored. Deliberate runtime replacement remains
dependent on source-owned reconciliation/settlement evidence and a distinct
reviewed recovery action. No automatic replay, restart, or admission reopening
is authorized.

The separate root gateway wiring at `508158a1` was reviewed and tested by its
owner; those actual HTTPS results are not reproduced or relabeled here.
