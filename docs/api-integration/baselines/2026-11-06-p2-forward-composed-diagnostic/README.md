# Composed forward failure propagation

Implementation `9a1bb50a` plus `545424f4`, isolated from actual failed Linux source `c7ae8e9fd16c1332d520e08e0b052bded019a934`. The same two owned fixture files and existing diagnostic test changed; production bridge, parent, guards, migrations, roles, source caps and workflows are unchanged.

The original CI run `42210725374`, job `127868425433`, ZIP is preserved byte-for-byte. SHA256 `965678488af9be4074b6eff05e6e6e36d0345899a12ad4e18213813cb7a93e58`. Its retained actual Linux four-part PostgreSQL18 receipt records roles24/release18/native9/cert9 before the forward failure. The forward failure still has generic Error/unknown/no frames, phase `forward-new-build-probe-promote`, inner stderr1545/stdout0 and empty bridgeErrors. This does not identify its cause.

The source boundary `withRecoveryFrontendSession` replaces callback errors with a generic exception, losing their original Node code/stack. The fixture now captures the actual build and mutation-verifier errors immediately before that sanitization. Guard codes require a selected source literal in the same exception's source-relative stack frame; message-only collisions remain unknown. No raw message, SQL, URL, credentials or actual/expected values are retained.

The composed regression traverses the actual outer Python `report_child_failure`, real Node child, byte-identical copied production bridge, generated Python shim and actual source helper. It exercises four fixed controls, using owned provider metadata and modeled physical callbacks, with no database access in those controls:

- A deliberately mismatched conclusive prior-build reason performs only GETs, fails the real Python `P2_FORWARD_CONCLUSIVE_FAILED_BUILD_REQUIRED` guard and survives into the final outer envelope.
- A real production Node pre-spawn guard survives with empty Python diagnostics.
- An actual IPC checkpoint invokes the real opaque-scope refusal; its source Node `forward-brand` guard remains mandatory. Any child EOF cleanup projection is retained as typed cleanup and cannot replace that guard. Empty Python metadata is allowed here because the child can be terminated before projection.
- A message-only collision is projected as unknown and has no Python record.

`composed-outer-envelopes.json` retains the four actually executed final envelopes at `545424f4`:1962/1442/2312/1139bytes. In that run the pre-spawn/checkpoint/collision controls had empty Python diagnostics. These are diagnostic component models, not operator authority or live recovery evidence. Intentional control records are removed from the unexpected-failure directory before the normal fixture, so they cannot masquerade as the later failure.

The actual Node24/PostgreSQL18 normal forward run at `9a1bb50a` passes all83/22/11 migrations and the same nineteen assertions, skipped0/stderr0. Final `545424f4` only corrects optional checkpoint EOF cleanup semantics; all twelve focused tests, including the real composed controls, pass there. Focused lint passes. Independent review cleared both commits with no actionable findings; its report hash is in `manifest.json`.

The Linux failure cause remains OPEN until a new Linux run captures the error before the generic wrapper. No skip, production guard change, platform-specific cause assumption, Docker-daemon start, global installation, live provider operation or release acceptance is claimed.
