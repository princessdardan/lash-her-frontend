# Chit Chats transient-effect component evidence

Base: `a85ae6deb4d98976caacfb7e726d32245e2bf97e`. Historical source audited: `b99d4f346696f897fa6a6729dfcc52d6503fe8d6` (C07).

The owned fixture ran18 tests, including actual fixed read-only SQL on PostgreSQL16 after all83 migrations, with synthetic private data over verified TLS/SCRAM and owned HTTPS. No live provider, credential, database, deployment, DNS or financial operation occurred.

Reproduce from the repository root:

```sh
CRM_SHIPPING_OWNED_POSTGRES_TEST=true python3 -m unittest discover -s ops/platform/host -p frontend_chitchats_transient_effects_test.py -v
```

`PG_BIN` may select the PostgreSQL16 binaries; default `/opt/homebrew/opt/postgresql@16/bin`. `NODE_BIN` may select Node24; the source payload canonicalization check uses its existing local Node24 binary. No dependency install or database URL is required. The fixture creates and removes its own local cluster and generated credentials.

`source-audit.json` hashes the immutable historical blobs; `sql-query-contract.json` records the fixed literal query interface for the shared bridge owner. `validation.json` binds source, tests, docs, these contracts and the test log. Original combined provider receipts and old evidence are unchanged.

The first unprivileged loopback attempt was rejected by the workspace socket sandbox; the test was rerun with the approved local-fixture permission. That was an execution-environment limitation, not a live integration result.
