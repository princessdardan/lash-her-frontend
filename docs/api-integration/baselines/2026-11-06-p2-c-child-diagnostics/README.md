# C child diagnostics

Reviewed diagnostic source `36bb3bd` and private-wrapper test `13f22569` are integrated at `c89b4da5`. [Validation](validation.json) retains original failure identity and source-specific evidence. Root Node checks pass 49/49 with zero skips and ESLint passes. The initially absent local gateway dependency was installed from its own lock; its original setup failure is retained privately.

A real failing generated child now emits only bounded allowlisted kind/code/cause/static-module/source-frame metadata. The actual parent forwards it before cleanup, and the existing private CI wrapper retains the exact bytes with mode `0600`. Canary values are absent. Success schemas, selectors, guards and production/B sources remain unchanged. The original Linux cause is still UNKNOWN; this change enables diagnosis and is not a claimed fix.

Local owned PG18 positive passes in 144.8 seconds with 83/22/11 migrations and empty stderr, using root jose 6.2.15/gateway 6.2.3 and matching installed-version metadata. This is not a full npm-ci closure or Linux/Docker/provider qualification. The owner qualification's pending-wrapper field is retained as original and explicitly superseded by the separate cleared wrapper test.

The [original D5 helper snapshot and resolver](../2026-11-06-p2-known-ack-interrupted-restoration/source-d5-final-seven-case/README.md) preserve the source pinned by original unchanged receipts; the active helper has advanced. No staging action, candidate publication or acceptance is established here.
