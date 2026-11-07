# Direct lifecycle worker recorder owned qualification

Exact implementation: `fff396ad54fa527c86c100a52a8d499e32c29146`. Node 24.18.0, owned PostgreSQL 16 with verified TLS/SCRAM, three disposable loopback databases. No staging/provider operation occurred.

`owned-pg16.json` records 83 frontend, 22 Course and 11 Community migrations and eight passing named checks. It executes the actual default exported frontend cron, admission/store/dispatcher, both pinned API routes and repositories, real header-to-completed-operation join and both delivery ACKs. Course denial is actual protected HTTPS 403; Community denial is its configured current member verifier, actual TLS database repository and actual private account-access hook. The receipt labels two receiver denials and one HTTP denial.

Node tests: 4/4; host protocol/FD tests: 6/6; focused lint: PASS. Source and raw evidence hashes are in `manifest.json`. The stderr contains the existing TypeScript module-type warning only.

The owned fixture uses a loopback transport with synthetic workload OIDC. It does not qualify the source host Docker class, opaque parent transport, deployed browser, actual workload OIDC, native provider classification, natural token expiry or a release. The live parent case remains OPEN until its real fixed integration is reviewed and exercised. No live credential was acquired.

Earlier failed fixture setups are retained unchanged as `prior-failed-*`: service environment initialization, required generated Course settings, the local dependency/server-only resolver, diagnostic column selection and strict admission URL CA handling. The final fixture supplies only `sslmode=verify-full` and trusts its generated owned CA through the child process. No application business guard was weakened to pass.

Reproduction:

```sh
node --test ops/platform/p2-lifecycle-worker-evidence.test.mjs
python3 -I -B -c 'import sys,unittest;sys.path.insert(0,"ops/platform/host");import p2_lifecycle_worker_evidence_test as m;unittest.main(module=m)'
P2_LIFECYCLE_WORKER_OWNED_TEST=true OWNED_POSTGRES_MAJOR=16 PG_BIN=/absolute/postgresql16/bin node ops/platform/test-p2-lifecycle-worker-local.mjs
```

The two API source roots must be the exact pinned commits in the receipt. Only self-owned ephemeral databases are used; the fixture removes them on completion.
