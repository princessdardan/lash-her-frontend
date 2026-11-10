# Forward recovery engine component evidence

This records the initial host component result and a later integrated physical-session/shared-reader result. It does not qualify actual all-service host restoration, forward-mode CI, or staging execution.

`python3 -m unittest p2_recovery_test -v` from `ops/platform/host` passed 28 tests against disposable private receipt directories, actual loopback TLS provider/probe servers, and physical POSIX locks. Twelve new forward cases cover failed/canceled originals, expired retained READY probe, exact current FE/API and intent receipt bindings before POST, one same-source deployment, fresh authenticated private probe, promotion, original receipt preservation, metadata changes, missing original create acknowledgement, unsettled alias, lost new create/promotion acknowledgements, and guard loss. Three retained-read cases also run through the extended TLS handler.

The provider harness is synthetic and owned by the test. It preserves metadata from actual create request bodies and serves actual GET readbacks. The production named source-pin, feature/runtime configuration, stage, probe, and promotion helpers execute without replacement success callbacks. No provider, application database, or secret retrieval is contacted. The API-current inputs in this host component fixture are generated fixture receipts; actual physical FE/API qualification remains the separately recorded current-only PostgreSQL fixture. A real physical-session brand and shared adapter handoff, integrated forward controller, fresh CI and independent final review are still OPEN.

Lost acknowledgements remain `P2_RECOVERY_NEW_BUILD_REQUIRES_REVIEW`. The existing exclusive directory prevents replay. No successful original terminal is created and no original receipt is rewritten. A new recovery build has its own action metadata and preserves the original candidate release/source.

## Integrated component follow-up

The later `host-integrated-tests.log` records 29 passing tests after the control correction was integrated. Its additional actual HTTPS test proves that an unreviewed READY sibling with the same Git source remains inventory drift even when the current forward scope is valid, then proves the repaired inventory is accepted. All reads in that interval are GETs.

`owned-forward-postgres16.json` records a separate explicit fixture mode:

```sh
P2_RECOVERY_OWNED_TEST=true OWNED_POSTGRES_MAJOR=16 NODE_BIN=/path/to/node24 \
  COURSE_RECOVERY_SOURCE_ROOT=/exact/course/source \
  COMMUNITY_RECOVERY_SOURCE_ROOT=/exact/community/source \
  python3 ops/platform/test-p2-recovery-owned.py --forward-brand
```

`PG_BIN` may select the exact PostgreSQL binary directory. The fixture verifies the actual binary major and accepts only 16 or 18. It creates a new loopback TLS/SCRAM cluster, runs the real 83/22/11 migrations, verifies both APIs current through their mandatory source-owned readonly role exports, and retains the real frontend physical session while the named provider helpers create one new deployment, execute its authenticated private HTTPS probe, promote it, issue the opaque scope, and pass it through the real shared JavaScript/Python observers and exact new workload reader. The source graph resolves the issuing and reading module to the same canonical URL. The original failed attempt remains a known terminal sibling and is never relabeled as current or successful.

Seventeen literal named groups cover the positive path and cloned/plain scopes, wrong client/verifier/plan/candidate/target/directory/inventory/action, shared mutation operations, altered receipt bytes, expired physical session, and mutation refusal after admission opens while preserving GET observation. The owned provider server independently verifies exactly one create and one promotion, with only GETs after the final POST. The original receipts remain byte-identical. The fixture poisons ambient Node/database/provider configuration and proves the same environment isolation as the default runner.

The generated ten-container records are explicitly synthetic (`actualRuntimeContainers:false`). This component fixture does not claim actual host runtime restoration or gateway traffic acceptance. The existing supervised transport/host fixtures cover their own boundaries separately. The command without `--forward-brand` still emits the unchanged 55-case/39-fault single receipt, reproduced in `current-only-regression-postgres16.json`. Integrated control/transport tests passed 12 cases; ESLint, Python syntax and diff checks passed.

The final manifest binds the exact source and evidence bytes and API source heads. Actual before/after journal digests for all three databases are unchanged. PostgreSQL 18 forward-mode CI, independent final committed-tree review, actual host all-service restoration, real Vercel/private-probe execution, and deliberate staging admission restoration remain OPEN. An uncertain new provider mutation requires review; this package provides no automatic retry or continuation of that uncertain attempt. Any staging execution requires Dardan's reviewed start.
