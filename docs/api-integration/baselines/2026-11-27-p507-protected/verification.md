# P5-07 protected staging qualification

## Candidate

The isolated candidate ran frontend `7ec71c1608681ca4cd547f2b704a603483646110`, Course `31e773262caae41ff3931222c8aabbc75547ca88` and Community `fc112ae6516c282ca73bf69efb82c74a9d007ade` on the existing staging host. Signed platform release `p1-45937924797-2` used activation `p5-06-7ec71c16-p507-45937924797` with a separate PostgreSQL 18 cluster. The corrected protected lifecycle deployment was `dpl_8ZvUeMTiohc2sxsEHFpW6Rgb9P71`. [Exact frontend validation](https://github.com/princessdardan/lash-her-frontend/actions/runs/45935504433) · [Signed platform release](https://github.com/princessdardan/lash-her-frontend/actions/runs/45937924797/attempts/2)

## Course-to-Community propagation

All 75 timed Course transitions matched a committed Community event and projection. There were zero pending, failed, missing or unmatched events and zero pacing violations. P95 was 1.097 seconds and P99 was 1.162 seconds against the 60-second and 300-second targets. The separate backlog drill verified all 100 projections within 59.599 seconds of publisher admission.

The concurrent protected browser workload completed 410 reads in 205 cycles with zero request failures and 20 missed early cycles. Its upper stage used 10 browser contexts. The workload covered protected reads. Launch-capacity verification remains tracked in Phase 6.

## Hosted account lifecycle

The ready archive matched the owner profile, current Community projection and active Course grant. The owner received HTTP 200, an unrelated signed-in peer received 404, and an anonymous request received 401. The export response was private and non-cacheable.

Chrome authenticated the staging Google Owner and exercised suspension and restoration on the isolated account. Suspension invalidated the existing session before either API receiver acknowledged. With Community acknowledged and Course still delivering, the account remained suspended with zero sessions. After both acknowledgements, a fresh session worked, the old session failed and the separate course participation sanction still denied a protected media ticket.

The initial concurrent Owner bootstrap left two uncertain ledger entries. The persisted Owner, linked draft records and exact successful fallback supported reconciliation at closed epoch 19. An interrupted Community transport test later left a gateway and native entry uncertain. Three-store readback showed no receiver restoration effect. The native entry was reconciled and the isolated gateway was replaced with the same signed image. The original gateway uncertainty was retained in the evidence.

## Export expiry acceptance

An isolated rerun used verified TLS and SCRAM against three disposable PostgreSQL 16 databases. It used the recorded service sources with a 60-second lifetime in the Course and Community snapshots and their matching database interval constraints. Frontend logic used its normal rule to cap the combined archive at the earliest receiver deadline. The check used real monotonic elapsed time without advancing clocks or editing export rows.

Before expiry the owner received the archive and the peer and anonymous requests were denied. After 60,886 ms all three services denied retrieval before the workers ran. Normal Frontend cleanup cleared both payload columns and retained the expired row. Course and Community each removed one export row. Replaying deliveries and repeating cleanup recreated no archive. All eight native operations completed and the disposable database listeners were removed.

The original hosted export retains its standard lifetime. Its final receiver deadline rounds to 01:39:49 Toronto time on November 28. Its natural expiry and worker cleanup are supplemental P5-07 evidence. P2 staging certification has its own acceptance criteria.

## Terminal deletion preparation

A separate disposable account and peer exercised protected Community posts, replies, profiles, preferences and processed private images. The staging Owner resolved the peer's test report in Chrome. The normal lifecycle recovery job acknowledged both receivers and produced a ready archive for the disposable account. Closed-epoch readback verified the three ready archives and the original observation account's exact retained expiry timestamps. Permanent deletion and its storage readback are pending.
