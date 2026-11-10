# Corrections to the Node data component

This record qualifies source `83fcfcef9da54acdf0b6626c708fe6c2a629a3c7`, including correction `c488aa1a2ab8ef16fd9b44ab08a81dd8b5fd019b`. Original source `dcea40053ed51e7ffe59649279097a0701d672e7` and its evidence remain unchanged and are superseded for the three findings below.

The descriptor guard now requires enumerable own data properties, including array elements. This prevents structured cloning or canonical encoding from dropping a validated required value. Regressions cover the root version, nested profile version, nested selection generation and nested array index through validation, encoding and hashing.

A shared capture-to-lease predicate now joins the fixed case slot/event type, lease hash and environment/asset/attempt/lesson/generation selection before either capture-set consistency or send-budget assessment. Each mismatch is tested with the correct lease hash, structurally valid capture and otherwise sufficient 15-second remaining budget.

The module no longer imports the profile-registry helper. The former import performed explicit registry filesystem reads before dispatch, so the original module-level no-I/O claim was too broad. Local bounded JSON parsing with fatal UTF8 decoding plus byte-exact canonical sorted JSON/LF comparison retains duplicate-key, invalid UTF8 and noncanonical-byte refusal. A fresh actual Node process installs filesystem open/read tripwires before import; only the two exact JavaScript source paths and corresponding source-file descriptors are allowed for module loading. Target import and dispatch produce zero explicit registry reads; importing the former dependency trips the same guard. The public dispatch function remains unconditionally unavailable without inspecting its arguments.

Node 24.18.0/macOS passed all 18 tests, zero skips; focused lint passed. Final source/test size is 34,831 bytes. Root rebalanced the same overall component allowance to Node <=36KiB and host <=100KiB; this changes no source-count, transport, per-record or stage limit. Test-table/assert-import/title changes preserve existing vectors while fitting the original interim cap; the extra import/dispatch regression fits the approved rebalance.

This remains syntax/data-only projected component evidence. Factory, allocated-profile registration, actual physical observer, source parent, host HTTP/source response join, PostgreSQL, Linux/Docker, provider and staging qualification are absent. Production ARM/dispatch are false; S05 live remains OPEN. No live action or provider/resource access occurred.
