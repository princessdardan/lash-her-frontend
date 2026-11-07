# Fixed read-only Git source selection

Code commit `2dcb00af` follows the lifecycle fence fix `49ad7ef0`. Blob reads and the shared parent/child fixture HEAD lookup now set per-command `safe.directory` to the canonical selected source directory. The closed Git environment ignores ambient repository/configuration overrides, uses no global/system configuration, disables replacement objects and optional locks, and suppresses pager/external diff/text conversion. No persistent Git trust setting, hook, credential helper, fetch or write command is added.

`protocol.log` records 17 passing tests, including a real Git invocation with poisoned ambient `GIT_DIR`, `GIT_WORK_TREE` and `GIT_CONFIG*` variables. It still resolves the selected source HEAD and verifies its fixed source blobs. `postgres16.json` records the actual owned PostgreSQL 16/TLS/app/HTTPS rehearsal: all 83 migrations and nine checks pass, including the barrier acknowledgement refusal. Focused lint passes.

The rehearsal's app Git revision is retained separately from the committed qualifier byte hash: tests ran while preparing `2dcb00af`, using app revision `5d26e3e5`. Reviewed app blobs were unchanged. `validation.json` records both identities and exact artifact hashes. The existing Node typeless TypeScript warning is retained in stderr.

The local fixture does not reproduce a Linux UID mismatch or a read-only Git mount. CI's real checkout/container ownership boundary remains the required actual check, with the selected `.git` directory mounted read-only. PostgreSQL 18 and live provider-native qualification remain unclaimed. Earlier failure and success records in the parent directory remain unchanged.
