# Patched zlib runtime

Both frontend-owned distroless Node images use this build. No image is deployed by these scripts.

Debian's pinned zlib 1.3.1 source contains the stale caller-input pointer after a failed gzip write described by CVE-2026-76844. `upstream.patch` records upstream commit `df84af25dc1942490e1d1c899a07619152a46148` (also referenced for CVE-2026-85091). `backport.patch` adapts that pointer/input reset to 1.3.1's direct-input branch without importing later nonblocking-write behavior. Both patch hashes, the Debian descriptor/source/packaging hashes and the compiler image digest are in `inputs.lock.json`.

`build.sh` verifies every input, applies the backport without fuzzy matching, runs upstream checks, and requires the original native failed-write assertion to fail before the patched static and shared-library tests pass. The shared test uses `/dev/full`; it runs again against the installed library in the final nonroot read-only image. A separately rebuilt reference package must match the final library, regression executable and provenance bytes. The custom Debian package uses a distinct `+lash1` revision, derives libc dependencies from its actual symbols and retains Debian's license file. Package archive timestamps are fixed; no compiler, shell or source tree enters the runtime image.

## Build and verify

Build the gateway with `docker build -t lash-her-gateway:local ops/gateway`. The migration image uses its existing root-context build and source-commit argument. Both Dockerfiles use the same `zlib-build` target and this directory. Verification requires Docker and Trivy 0.76.1 on PATH:

```sh
trivy image --list-all-pkgs --format json --output /tmp/gateway-raw.json lash-her-gateway:local
node ops/gateway/runtime/verify.mjs lash-her-gateway:local /tmp/gateway-raw.json /tmp/gateway-runtime
```

Use a new output directory. The verifier retains raw-scan hashes, an SBOM, exact image/package bindings, independent build evidence, an OpenVEX `fixed` document and the enforced scan. It refuses changed source/library/test/package/image identities, failed controls or unrelated HIGH/CRITICAL findings. The VEX document is generated only after actual installed-library checks and applies only to the exact product digest and custom zlib component. It is not a claim that unpatched packages are unexploitable. The raw finding remains retained when Debian's scanner data lacks the private backport revision.

CI and candidate publication run the same verifier. Candidate collection checks the retained file hashes, source lock, raw and filtered findings and exact published digest. Other artifact families cannot use this filtering. No ignore list, severity downgrade or `ignore-unfixed` option is used.

## Updating or removing the backport

A source, compiler, patch or regression change requires reviewed lock updates, original-fails/patched-passes evidence, repeat reference-build comparison, both final-image smoke checks, fresh scans and exact-head CI. Keep historical evidence immutable. The layer can be removed once a digest-pinned maintained base ships a recognized fix: qualify the replacement images, remove the private package/VEX path and restore direct scans together. Retiring the layer requires source and image evidence; changing package metadata alone does not establish a fix.
