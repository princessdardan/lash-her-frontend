# C Linux temporary-root correction

[Validation](validation.json) binds reviewed helper `070eb31c`, adapter `b75da9f3` and root `5ae68a6c`. Exact [96df CI diagnostics](../2026-11-06-p2-c-child-diagnostics/ci-96df-failure.json) identify the inner receiver IPC rejection at generated old B at 45:201. A direct unchanged-source guard replay confirms `/tmp` rejection; a supported canonical root passes that first guard and reaches the expected later missing-dependency refusal.

Only C positive/negative descriptors move their existing single 512 MiB temporary mount from `/tmp` to fixed `/var/tmp`, with identical options and budgets. They supply fixed `TMPDIR=/var/tmp`; the helper forwards only its newly created canonical owned folder to the child. Other descriptors, read-only sources, public selectors and the original receiver guard are unchanged.

Root Node 50 and ESLint pass; independent helper 8/adapter 39 checks pass. Exact local PG18 positive passes in 142.5 seconds with 83/22/11 migrations and empty stderr. These are source/local boundaries; actual paired Linux/Docker success remains required. Original failures and receipts remain immutable. No resource, provider, staging or candidate-publication action occurred.
