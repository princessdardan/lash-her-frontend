# Diagnostic independent-review corrections

Original implementation `b4f71dcc` and its evidence remain unchanged. Independent review found two medium defects in that diagnostic: an incomplete SSLCertVerificationError or throwing error property could interrupt projection; and an external error whose text collided with a known literal could be mislabeled as a source guard without a call-site join.

Correction `008ed697` protects all exception args/HTTP code/TLS verify/cause/context/reason/traceback property reads. Missing or throwing properties produce closed unknown/null values. The inventory now maps each literal code to its fixed AST source file and line range. An emitted guardCode requires a matching call site in the same exception's actual traceback. An unthrown colliding ValueError remains unknown.

The positive unit invokes the actual source ProbeClient invalid-origin guard with a suppressed owned HTTP401 cause; negative units cover literal collisions, incomplete SSL and hostile HTTP properties. All eleven diagnostic tests pass. The complete actual Node24/PostgreSQL18 forward fixture still passes the same nineteen checks, all83/22/11 migrations, zero skips and empty stderr. Its normal pass receipt shape, provider-call counter, journal-preservation flags and source guard assertions are unchanged.

The original Linux failure cause remains OPEN until the new Linux run captures the safe nested diagnostic. No production code, policy, shared runtime, guard, source cap, workflow or pass criteria changed. No provider or live staging action occurred.
