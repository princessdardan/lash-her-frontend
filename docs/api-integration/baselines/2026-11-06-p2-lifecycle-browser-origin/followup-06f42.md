# Actual producer join and private-input boundary correction

Correction `06f42ac1` consumes root handler contract `2a33ae80` as the isolated dependency `ab87c9e1`; root already owns the original dependency. The correction changes only the new Python alias observer and its tests.

The independent review found that the final private-input read was validated but discarded. A changed valid secret, gateway origin or later expiry could therefore pass. The observer now compares the complete final private projection to its original in-memory value, without printing or retaining credential values or their hashes. Three owned replacement cases refuse before a successful observation. No probe expiry is extended.

The new joined case imports and executes the actual TypeScript `readReleaseProbeConfiguration` and `createReleaseProbeHandler` under Node24 with generated private fixture configuration. Its actual `phase2-auth-origins` response passes through the source fixed-alias HTTPS client and observer. Wrong customer/admin origins or a configured admin proxy return 503 before the modeled catalog call. The generated secret/config remain private process input; no live configuration was read.

Final exact-source results: eight owned HTTPS tests and 15 focused Node tests pass, zero skips. Alias/provider metadata and catalog delivery remain explicit owned models; this is actual producer/consumer compatibility, not deployed alias, workload OIDC, provider or normal-browser certification. Previous evidence and the original six-test observer qualification are preserved unchanged.
