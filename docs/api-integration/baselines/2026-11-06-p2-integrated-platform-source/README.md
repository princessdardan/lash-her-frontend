# Integrated platform source regression

At 20b4fc40 the gateway/platform suite passed 442 of 459 cases with 17 explicit skips. All 590 host cases finished with eight explicit skips and no failures. Types and released contracts passed. The first lint run failed on the Next bundler rule for `module` variables in two immutable standalone Node evidence snapshots; 826076e2 applies a precise rule override without changing their bytes. Corrected lint has zero errors and 14 warnings. Original and corrected logs are retained as deterministic gzip with original/archive hashes.

These are regression results before the independently found recovery role/ACL and inherited-environment faults are corrected. They do not qualify those missing cases. Exact selected API unskipped probes, PostgreSQL18/Linux/Docker, final candidate CI and actual staging remain required. No live action occurred.
