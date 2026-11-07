# Original D5 seven-case helper

This is the exact helper blob from `d5ee9bee1d3ef6ba23774bb41883eb3c8fb605c7`, SHA256 `2cae572e88ad1648e1419035376ee34795623b1ce26e1c53a8cebbdb7d66141c`. It resolves the original unchanged validation and PostgreSQL receipts. The active parent `run-owned.mjs` now includes the separately qualified diagnostic extension and is not the source pinned by those original receipts.

The [sidecar](../original-source-resolution.json) records the original validation hash and this retained source. Run `node docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/verify-original-source.mjs` from the frontend root to verify this resolution. No original validation, receipt or pinned README was rewritten.
