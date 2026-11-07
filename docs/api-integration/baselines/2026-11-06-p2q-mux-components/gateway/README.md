# Disabled S05 gateway capture components

Source commit: `3d1b1c6542fc55077d867b68218ed078c48caa5b`; base: `ff4c0a340b578e0d2c4df1c2c942209227a9f24c`. Only two new ops files, 56,040 bytes together, within the approved 56 KiB bound. No existing gateway/server/Dockerfile/Compose/runtime/lockfile source changes. Evidence is a separate commit.

The public factory returns exactly five frozen no-op hooks for every input, performs no I/O and cannot arm. There is no allocated target policy, source control factory, environment override, options verifier, public replay endpoint or test issuer. Profile references are syntax-only data, retain nonzero digests and cannot select/register an allocated lane.

Private components implement byte-preserving envelopes, canonical+LF metadata, separate two raw/two replay-observation slots, prescribed D1/R1/A1 data sequencing, bounded global admission metadata and commit-last private publication. The actual Course managed200, row/provider ownership and server-generated request IDs are projected input in these component tests, not authenticated by the component itself. Tests access private helpers only by appending an export suffix to exact module source in the test process. That suffix does not ship as a production module export or enable public arming.

Actual Node24 tests:

- 20 component/filesystem cases pass, 0 skipped. Two original raw captures do not exhaust replay-observation slots; duplicate/collision/refused-response/chronology/expired/clock/slot reuse cases remain unqualified. Safe projections omit private envelope digests, bytes, signatures and synthetic private canaries.
- Owned filesystem execution covers 0600 raw files in 0770 directories, file/directory fsync, commit-last writes, O_EXCL/symlink/inode/collision refusal, awaited-open revocation with acquired FD closed, fsync failure with partial private evidence and no commit, raw-buffer revocation and actual elapsed publication expiry. Identity is the executing local non-root user, not Linux UID65532/root-owned allocated mounts.
- All 58 gateway regression tests pass, 0 skipped; existing tests exercise owned loopback HTTP/TLS. The new package does not wire itself into that server or qualify a whole live/captured Course route.
- Scoped ESLint passes with no output.

Commands from this isolated worktree:

```sh
/Users/dardan/.nvm/versions/node/v24.18.0/bin/node --test ops/gateway/p2q-mux-capture.test.mjs
/Users/dardan/.nvm/versions/node/v24.18.0/bin/node --test ops/gateway/*.test.mjs
/Users/dardan/.nvm/versions/node/v24.18.0/bin/node node_modules/eslint/bin/eslint.js ops/gateway/p2q-mux-capture.mjs ops/gateway/p2q-mux-capture.test.mjs
```

The original first component run had 14 passes/4 failures: the macOS test tmpdir path traversed a symlink and was correctly refused. The fixture now uses its actual realpath; source path/inode/symlink checks were preserved. The original full failure log is retained unchanged, including its encoded test-projection source stack. It contains owned synthetic fixture values, no real provider capture/credential. The original test file was not separately frozen before correction; no runnable prior-source qualification is claimed from that log.

Joint DATA-ONLY schema is `c2c44f3895117af792b56bc0cd838e2a4f158f4e59a14d2be791b6f7349e1c8a`, manifest `2bc1ac2ffb51f71e262d0097b6d0be1f297473aae19b3d5c0b048b6044e8242f`. Original3458 files are byte-exact under joint-interface/original-3458. The frozen manifest's pending label is preserved rather than restamped; root subsequently approved its exact hash.

Limits: metadata/codec acceptance and current fsync are observations, not historical producer-ACK or resource authority. Ledger/counter consistency is not actual transport/business drain or provider-queue zero. Local writableFinished is not a Mux-observed ACK. This package does not verify HMAC authenticity itself; owned HMAC use demonstrates raw-byte preservation only. SDK300 and playback600 are unchanged. Actual allocated profile/control/host/physical observer, server/Docker/Compose wiring, Linux UID/mount proof, actual Course producer HTTP+PG proof and live approval remain required. No PG or Docker execution, or live provider/resource/native/admission/credential/deployment action, was performed. Owned fixture files and loopback servers are described above. Independent source review is pending.
