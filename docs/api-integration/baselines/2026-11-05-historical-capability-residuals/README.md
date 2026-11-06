# Required frontend and external residual channels

The previous `57d4e082` checker could return `unresolvedFamilyIds: []` alongside scoped Sanity/Mux closures stating that external capability was not declared absent. The current shared provider join retained `effectScope`; no actual shared-join bypass was demonstrated. The general helper field was nevertheless ambiguous for other consumers. `prior-control.json` reproduces that output through the exact prior committed source getter, original-record preparation, SQL observer and reducer using a complete empty synthetic original record.

Runtime/test source commit `f41c09ab82a307ce8eea95cabb4675f9e92133b5`; checker byte SHA-256 `2499451470e086b68c495970f9c696862b63b3dd297589f435eecd6320309655`.

The corrected reducer requires three explicit, sorted, unique residual arrays:

| Field | Meaning |
| --- | --- |
| `unresolvedFrontendSqlFamilyIds` | Families without a valid source-specific frontend private-SQL closure. The P2-00 frontend SQL barrier gates this list and actual per-family requirement/contradiction proofs. |
| `unresolvedExternalCapabilityFamilyIds` | Source-reachable audited `sanity.editorial` and `mux.studio` retain their external editorial/media uncertainty. This list is source-owned independently of whether a frontend closure succeeds. Source-absent Mux Studio profiles omit that family. |
| `unresolvedFamilyIds` | Exact sorted union of both lists. A general consumer cannot interpret a private-SQL exclusion as complete provider settlement. |

Consumers must require all three arrays, validate the external IDs against the branded exact source dispositions and reviewed predicate mapping, validate the frontend residuals against actual scoped closures and exact requirement coverage, retain both channels in compact/readback/final evidence, and reject missing or inconsistent fields. A missing field cannot default to an empty array. The provider integration owner owns those shared consumer changes; this bounded commit edits only the historical helper, tests and evidence/docs.

The C07 owned complete-empty pipeline still has 36 source-qualified **frontend SQL scopes** and an empty frontend residual list. It now retains `['mux.studio','sanity.editorial']` in both the external and general lists. This is no provider retirement/absence claim. Unrelated Sanity author identity, Studio addon operations, public or independently signed media, assets, and keys remain outside the P2 frontend SQL barrier and do not force unrelated credential/media retirement. Private Course media and signed Sanity product callbacks remain separate mandatory SQL requirements.

A configured Sanity webhook secret remains potential signed SQL ingress, including deferred product stock synchronization. With configured SQL it leaves `sanity.callbacks` and `sanity.editorial` in the frontend residual list. The external editorial residual is retained as well. Google retained/configured SQL grants, secret references, legacy Redis refresh keys, state, locks, and historical accepted-request ambiguity keep their original denials. No source predicate, profile, SDK gate, global SQL ID, requirement digest, or application behavior changed in this correction.

## Executed evidence

- `unit.tap`: 21 passing source/proof tests, no skips. The new regression executes all 33 exact source getters and verifies the external list, exact union, broad nonempty result, private scope annotation, and configured signed-callback denial. Existing grant/store/context/tamper negatives remain passing.
- `owned-empty.json`: actual C07 source getter → preparation → branded SQL collector → reducer; 36 qualified frontend SQL scopes, empty frontend residuals, two required external/general residuals. Original configuration is an explicitly complete empty owned fixture; it is not an actual deployment record.
- `owned-pg16.json`: 15 passing actual PostgreSQL 16 checks, 83 actual migration entries, four TLS/SCRAM read-only peers and 207 parent checkpoints. Retained ciphertext and secret-reference grants preserve Google frontend residuals. The receipt records all three channels.
- `owned-https.json`: 10 passing owned HTTPS protocol checks for both refresh-key variants, full paginated state, locks and denial/malformed/unstable state; all configured Google store negatives remain unresolved.
- `regeneration.json`: all 33 profiles remain byte-identical and regeneration preserves the corrected checker bytes. This correction changes only derived output semantics.
- `prior-control.json`: exact prior committed module output reproduces the ambiguous broad empty list while preserving external annotations; no live bypass or provider mutation was exercised.

Earlier success/failure receipts remain unchanged in the six-family baseline. This baseline's current drivers explicitly assert the frontend-specific channel. Owned peers and child processes are awaited and cleaned. No live provider, actual original configuration, environment database, secret, staging mutation, paid checkout, or production operation was used.

Reproduce with Node 24:

```sh
node --test ops/platform/frontend-historical-source.test.mjs
node docs/api-integration/baselines/2026-11-05-historical-capability-residuals/run-owned-empty.mjs
FRONTEND_HISTORICAL_SOURCE_OWNED_TEST=true PG_BIN=/path/to/postgresql-16/bin \
  node docs/api-integration/baselines/2026-11-05-historical-capability-residuals/run-owned-pg.mjs
FRONTEND_HISTORICAL_SOURCE_OWNED_HTTPS_TEST=true \
  node docs/api-integration/baselines/2026-11-05-historical-capability-residuals/run-owned-https.mjs
```

The previous source-only selected-database descriptor review note was downgraded: the concrete coordinator creates four fresh unpredictable 63-bit parent markers and rejects alternate peers before application observation. Stronger cluster-identity binding remains defense in depth; this correction does not change that existing boundary.
