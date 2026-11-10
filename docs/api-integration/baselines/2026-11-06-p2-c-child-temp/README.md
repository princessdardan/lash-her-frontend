# C generated-child temporary directory correction

At exact frontend 839d6a68ee6c45acdcb344cc3849b69c22ddbc7a, CI 42267467663 passed all eight ordinary jobs, including Chromium, Firefox and WebKit. The operator job 128063014240 failed before the C module entry: actual TSX 4.23.4 attempted its cache beneath absent /tmp/tsx-999. Original artifact 13527752449 is 4937bytes, SHA256 41cb39e9f810298b895006acee6d9444a562063ce23e58cd69d2d7597928796a.

Source a57697019a4d124eac38aa5b7a7054dc03d3f272 supplies the generated C Node child with TMPDIR equal to the same source-created canonical owned directory already used by its outer helper. It adds one explicit child environment field; no ambient environment is inherited. The prior /var/tmp mount correction remains unchanged. Production, B, provider, receipt schema and mount/byte budgets do not change. Root integration is b8832e7e.

The controlled actual-spawn/real-TSX reproduction is red on the original and green after correction; only Linux's absent default cache path is projected. Independent review clears the correction. The actual owned macOS PG18 positive route passes in 142.5seconds with 83/22/11migration chains, original three journal identities and zero stderr. Nine Node checks and lint pass. These are owned-source results, not a Linux container or deployed result. qualification.json retains exact hashes and original limits.

Fresh exact Linux qualification remains required. Original failed artifacts and original D5 source/receipts remain immutable; no historical receipt is restamped.
