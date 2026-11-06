# S13 authority timing source validation

This baseline records non-live validation of the source-owned S13 authority
timing package. It does not contain a customer, course, lesson, grant, command,
JWT, Mux URL/token, provider identifier, credential value or credential hash.

The package measures a controlled Course learner JWT at the deployed
300-second lifetime plus 30-second verifier skew, captures an actual Course
playback authorization with a 600-second Mux token, and qualifies provider and
browser renewal denial through source-bound external receipts. The controlled
learner token is explicitly not a frontend-issued token. The playback GET's
existing `lastTokenExpiresAt` cleanup-fence write and learner quota consumption
are explicitly labeled.

Owned validation covered:

- closed controlled learner claims using the existing identity helper;
- real loopback TLS with hostname verification for the fixed Course and Mux
  request paths;
- redirect, 429, 500, untrusted binding, alternate host/path/query, token
  subject/expiry and unsupported-status refusal;
- 200-to-401 and 200/206-to-401/403 transition qualification at exact source
  claim expiry boundaries without an invented grace;
- source/HTTP clock agreement with one-second HTTP Date precision;
- pending deliveries with zero attempts/leases/acknowledgements before the
  worker and two final receiver acknowledgements, all bound to the exact
  suspension command/version and separately reviewed evidence sources;
- capture-before-suspension and suspension-before-expiry ordering, so an
  unrelated already-expired token cannot satisfy the timing result;
- source-browser machine-artifact separation from host observations;
- fixed gateway child commands, a real POSIX host flock, bounded incremental
  waits, mode-0700/0600 private records, symlink/overwrite refusal and sanitized
  host failures;
- public-receipt exclusion of JWTs, provider URLs, playback IDs and credential
  hashes.

Node reported 6 passing tests and Python reported 10 passing tests, with no
skips. Focused ESLint, JavaScript syntax and Python compilation checks passed.
The owned HTTPS fixture is synthetic and does not claim the deployed Course
route or live Mux. No staging/provider/database/browser request ran.

Live S13 remains open. It requires a corrected, independently reviewed d355
lifecycle witness; the real S12 normal-UI suspension/worker/browser artifacts;
the exact owned staging free-grant fixture; actual selected container/TLS/API
execution; and restoration through S12 after finalization. The known d355
prototype is not accepted by this package: finalization pins separate reviewed
browser, pending-observer, witness-program and S12 source digests and refuses
mismatched command/version, candidate, configuration, pending or final receipts.
Source digests alone do not authenticate caller-shaped JSON. The host
`finalize` operation is therefore hard-refused until fixed adapters run each
reviewed evidence producer/validator against retained private artifact bytes.
