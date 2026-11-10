# Exact contract compatibility review

The ordinary `assertCompatible` release check remains conservative: additions and documentation changes are allowed, while changes or removals of existing wire operations, definitions or global security refuse. A coordinated P2 release can supply one committed exact-delta review through `--compatibility-review <JSON>` and `--review-revision <full-commit>`.

P2 uses the fixed file `contracts/api-integration/p2-candidate/compatibility-review.json`. The review and released manifest can be committed together. The review identifies the candidate by its manifest hash; the CLI independently requires `--release-revision` and `--review-revision` and compares their Git blobs. No record embeds its own commit ID.

The closed version 1 record has these fields:

- `kind`: `integration-contract-compatibility-review`.
- `baseline`: `revision`, `bundlePath` equal to `contracts/api-integration/v1`, and the bare SHA-256 `manifestSha256`.
- `candidate`: the bare SHA-256 `manifestSha256`.
- `changes`: the complete sorted inventory of added, changed and removed operations, component definitions and global security. Each entry has `document` (`course` or `community`), `kind` (`operation`, `component` or `globalSecurity`), `location`, `change`, `beforeSha256` and `afterSha256`. An absent definition has a null hash. Changed/removed entries require nonempty `requirementIds` and `reason`; additive entries may include them.
- `versionedDocuments.enrollmentEvent`: raw `beforeSha256`, raw `afterSha256` and `classification: "unchanged"`. The underlying bytes must be identical.
- `versionedDocuments.boundaries`: raw before/after hashes and `classification` equal to `unchanged` or `info-title-only`. A title-only change requires `requirementIds` and `reason`. After removing only `info.title`, the documents must remain identical. Identity, lifecycle and receipt changes cannot use this path.

Operation locations are lowercase method plus path, such as `get /v1/courses`. Their hashes use the existing compatibility normalization over the operation and inherited path parameters. Component locations are `kind/name`; global security uses `security`. Documentation annotations are excluded under the existing rules. Manifest and versioned-document hashes bind the exact bytes. Other top-level or path-level wire changes refuse. Unknown fields, duplicate entries, reordered or incomplete inventories, and mismatched before/after identities refuse.

`scripts/api-contract-compatibility-review.mjs` exports `readReviewBundleAtRevision`, `readReviewBundle`, `describeCompatibilityChanges`, `buildCompatibilityReview`, `validateCompatibilityReview`, `verifyCompatibilityReview` and `verifyPublishedPhase2Contracts`. The builder produces an inventory; the operator supplies the requirement mappings and reasons before validation. It does not change a manifest or authorize deployment.

For P2, the approved baseline is frontend commit `a08e4659ab37cd989f7d87dab0116f87eac965ec`. Extract its bundle directly from Git into a disposable directory. The verifier independently reads that revision's manifest, artifacts and normative README from Git and compares the supplied baseline directory to it. Relabelling the current v1 directory as released cannot substitute for the archive.

```sh
contract_archive="$(mktemp -d)"
git archive a08e4659ab37cd989f7d87dab0116f87eac965ec contracts/api-integration/v1 |
  tar -x -C "$contract_archive"
node scripts/check-api-contracts.mjs \
  --bundle contracts/api-integration/p2-candidate --release \
  --release-revision <selected-frontend-commit> --sources <repository-parent> \
  --baseline "$contract_archive/contracts/api-integration/v1" \
  --baseline-revision a08e4659ab37cd989f7d87dab0116f87eac965ec \
  --compatibility-review contracts/api-integration/p2-candidate/compatibility-review.json \
  --review-revision <selected-frontend-commit>
```

The P2 source gate verifies the fixed review against the exact selected frontend commit before issuing source proof version 4 or publishing artifact candidates. Checkout history must contain the reviewed baseline. The frontend migration image packages the review and verifier source alongside all six normative P2 files; its source inventory binds their bytes to the image's frontend source revision. Historical P1 recovery keeps its v1 bundle and proof semantics. The single-operator release policy governs the existing review and release action; no external signer or separate approval service is introduced.
