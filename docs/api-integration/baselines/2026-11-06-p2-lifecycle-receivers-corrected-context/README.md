# S12 corrected reader context, owned qualification

Source: `43eb6ead97c8af664057ec249821531568e5756d`. This is an additive
consumer correction to `4c607091`, using the corrected persistence reader
`078dd354` and the existing 448-file source limit. It requires the host machine,
recomputed three-target hashes including observed role OIDs, complete immutable
API image references, and the same authenticated full source map at both layers.
The public plan explicitly requires operator source to equal the immutable
frontend candidate source. Supplemental operator commits remain ineligible.

The exact committed source passed Node 24 tests (9), Python host tests (8), and
focused lint. The owned PostgreSQL 16 TLS/SCRAM run applied 83 frontend, 22 Course,
and 11 Community migrations, then passed all 12 named checks and eight actual
HTTPS cases through the pinned API modules. The receipt retains both API source
commits and the actual source hashes. Only disposable local databases were used.

The original `2026-11-06-p2-lifecycle-receiver-negatives` evidence is preserved.
This run qualifies the corrected consumer/reader contract and source modules;
it does not exercise Linux Docker, installed SSH transport, a deployed provider,
native scheduling, delivery-lease expiry, or a live browser. Live future-gap
requests remain refused and OPEN. No P2 item or release is certified by this
fixture alone. Quota writes are explicitly excluded from domain-state digests.

Commands:

```sh
node --test ops/platform/p2-lifecycle-receiver-negatives.test.mjs
python3 -I -B -c 'import sys,unittest;sys.path.insert(0,"ops/platform/host");import p2_lifecycle_receiver_negative_test as m;unittest.main(module=m)'
P2_LIFECYCLE_RECEIVER_OWNED_TEST=true PG_BIN=/opt/homebrew/opt/postgresql@16/bin node ops/platform/test-p2-lifecycle-receivers-local.mjs
```

Node executable: `/Users/dardan/.nvm/versions/node/v24.18.0/bin/node`. The stderr
file contains the existing Node package-type warning; the run exited zero.
