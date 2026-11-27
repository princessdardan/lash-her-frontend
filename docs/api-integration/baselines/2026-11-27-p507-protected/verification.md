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

## Hosted terminal deletion

A separate disposable account and peer exercised protected Community posts, replies, profiles, preferences and processed private images. The staging Owner resolved the peer's test report in Chrome. A subsequent peer reply gave the disposable account one persisted unread notification. Normal lifecycle recovery made the deletion fixture's version-1 export ready in Frontend, Course and Community.

The first Delete button attempt in Chrome timed out. A database and writer readback verified that the account was still active, its export was the only command, and all admitted operations had completed. With the confirmation field typed in Chrome, the next attempt submitted one request to the protected account endpoint. The request returned HTTP 202 for the version-2 delete. The old session immediately received HTTP 401 on the account and export endpoints, and the peer's session returned HTTP 200.

The closed-epoch readback verified Frontend session revocation, account redaction and archive byte scrubbing before either receiver acknowledged the command. The normal isolated recovery tick then acknowledged both receivers once. Course and Community recorded the same terminal command, removed their export copies and retained the command history. Community redacted three test content records and removed the profile, preferences and the exact reply notification. The peer's profile, content, enrollment and moderation report remained intact, along with the resolved report's audit record and the original account's independent sanction and ready export.

Before deletion, S3 listed the awaiting-upload original, the processed subject image and the peer image in the isolated unversioned bucket. Community accepted deletion before the upload grace deadline. The normal media worker recorded removal of the processed image and then removed the original after the six-minute upload and cleanup window elapsed. Exact-key S3 listings verified both removals and an unchanged peer image fingerprint. The account had exactly two media records, both marked removed. A second S3 check verified absence of the processed image's earlier original and the quarantine-only image's unused derivative key.

Both isolated admission gates closed and drained without active or uncertain work at epoch 45. The temporary Chrome sessions were retired, scoped logins were held, and the apps and loopback stopped. The PostgreSQL supervisor's cleanup command reported a Docker error after its closed-state witness. Independent readback verified that the isolated PostgreSQL container and listeners were gone, the database volume remained, and the shared inventory matched preflight. The isolated media bucket's original CORS was restored.
