# Adjacent frozen identity receipt findings

This additive failed record preserves the same frozen application source as the earlier two-finding run, with four further real Auth.js export failures. It does not replace that [original record](../2026-11-05-p2-00-identity-admission-frozen-findings/validation.json).

- Suppressing session deletion returns a successful sign-out while its original database bearer remains valid.
- Reinserting a token in an `AFTER DELETE` trigger returns a sign-in cookie while the consumed proof remains present.
- Suppressing a Google provider-link insert still returns a sign-in cookie with no durable provider link.
- Resetting throttle attempts after insert/update allows the email request while both durable counters remain zero.

Each faulty request completes its admission entry on this source. Together with the original missing token/session insert cases, the [receipt](postgres16.json) records six findings, 20 passing independent checks and 26/26 passing existing DB regressions. The launcher exits 1; source qualification has failed. Source and fixture hashes, synthetic-provider boundaries and native Next/browser limitations are explicit in [validation.json](validation.json). The application owner was notified; no application source is changed here.
