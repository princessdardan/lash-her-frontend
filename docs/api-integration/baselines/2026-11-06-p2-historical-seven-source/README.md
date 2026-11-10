# Seven exact historical frontend source profiles

This package adds exact source support for seven previously unmatched frontend revisions. It does not infer support from ancestry. Each entry reconstructs a complete generated profile from one immutable reviewed base through the closed, typed delta register at `ops/platform/profiles/frontend-historical-source-deltas-v1.json`, then applies the existing full Git-tree, blob, inventory, and annotation-excerpt verifier to the selected revision.

The 33 stored full profiles and seven existing exact-tree aliases remain byte-identical. The following five deployment identifiers still have no source SHA and remain unknown: `dpl_5JDDu6BaZcM4sg9wip65MKCwmhuL`, `dpl_7mG5ncqdKCBhpxNJ281Amqw9upe4`, `dpl_7odqGL3divDTEMqdBbkZWu2FzqX4`, `dpl_BYQiXkALFy2hjG2KVKUG7XEgYpyE`, and `dpl_rzM1LuvDQzn4N1hKouWRymhPqf7j`.

## Generation

Run from the exact reviewed frontend checkout:

```sh
node docs/api-integration/baselines/2026-11-05-p2-historical-source/generate-reviewed-profiles.mjs --write-reviewed-seven-candidates
node docs/api-integration/baselines/2026-11-05-p2-historical-source/generate-reviewed-seven-deltas.mjs --write-reviewed-seven-deltas
node --test ops/platform/frontend-historical-source.test.mjs
```

The first command writes full candidate profiles only to `/private/tmp/lash-her-reviewed-seven-candidates`. The second command reconstructs every candidate from its pinned base before writing the aggregate register. The committed runtime independently repeats that reconstruction and verifies the actual target Git objects.

Revision `8745a463e310371a5c8a6b98dd12f5643feb289f` explicitly records `scripts/update-approved-service-descriptions.mjs` as a direct Sanity caller. Its profile records `SANITY_API_READ_TOKEN` and `SANITY_WRITE_TOKEN` as alternative capability paths, the transaction/patch/commit mutation path, and the fixed production project/dataset source. The resulting private-SQL scope remains distinct from external Sanity editorial capability; it is not a provider-retirement receipt.

No provider, Vercel, database, credential value, or live environment was read. This evidence is source-only and does not qualify staging, historical effects, provider drain, or release admission.
