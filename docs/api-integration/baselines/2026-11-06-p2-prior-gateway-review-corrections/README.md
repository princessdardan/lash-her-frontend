# Prior gateway review corrections

The independent review of `843b00819b8fa08e2274d3066e6e856856f4fac2` identified two defects. An inspectable stopped container could override a contradictory same-process lineage pointer, and gateway-last completion could accept the unchanged old container.

`original-843-reproduction.log` was produced against the unchanged helper SHA `954e6d8002f58d6baf401a6c92ac5c2f343dcb4d965a7f952a2631058759aafb`. Two new test methods failed seven assertions: the present stopped-container path accepted same-process pending/refused/running pointers, accepted three mismatched stop-pointer fields, and accepted a no-op gateway replacement. The real owned gateway/process fixture was used; Docker metadata remains a fixed fixture projection.

The correction requires any existing pointer to match `stopped-observed`, exact process, binding, stop directory and stop receipt hash, even while the stopped container is inspectable. An exact latest pointer is required even when the stopped container remains inspectable. Pointer deletion/loss is unknown and refuses; the source ordered-stop writer publishes the required pointer. Gateway-last completion requires an actual new container ID before publishing running lineage or completing the boundary. A no-op leaves the replacement pending and completion false.

The reproducible final negative cases also include the root-required missing-pointer refusal; `original-843-final-regressions.log` records eight failures against the same exact original helper. The earlier seven-failure reproduction remains immutable.

The final host run includes both new regressions and the existing positive P1, real gateway replacement, runtime, independent guard, and containment cases. The original 843 baseline is unchanged. This evidence claims source qualification with owned HTTPS/process/flock execution; no live Docker, staging, provider or release action occurred. Independent clearance is recorded separately by the reviewer/root.
