# Course media and export-cleanup host integration

Source-only integration for the two independent Course workers in the reviewed platform topology. No staging environment, credentials, runtime, schedule, watchdog unit, or production resource was changed.

`host/release.py` snapshots dedicated `course-media.env` and `course-export-cleanup.env` files and starts the workers with snapshot/Community workers after API/TLS readiness and before the publisher/gateway stages. Both use the exact Course runtime image. Preflight invokes the compiled `parseMuxMediaProcessEnv()` or `parseAccountExportProcessEnv()` in an isolated configuration container.

The raw files use closed scopes. Both allow only NODE_ENV, DATABASE_TARGET, and the selected named database URL. Media additionally allows its Mux token ID/secret/environment and recovery/cleanup/poll controls. Export cleanup allows only its cleanup/poll controls. API user/admin/service/signing/webhook/Resend credentials and unknown keys refuse. Compose may supply only exact NODE_ENV/PORT/heap-size overrides; it cannot inject API credentials or enable loops outside the protected file. Existing TLS, runtime-role and selected database guards remain mandatory.

Failure suspension recognizes both exact worker names and retains their 60-second graceful stop window, with a bounded 90-second command wait. Unknown project services still refuse; zero remaining running project containers is required. `host/watchdog.py` includes both workers under the existing environment flock, three-per-hour/five-minute budget, and durable intent before a restart. Their Docker restart grace is 60 seconds and the command bound 70 seconds. A timeout consumes its existing durable budget and does not immediately retry.

Current release tests exercise all ten services, including failure cleanup and closed credential scopes. Historical P1 test fixtures explicitly retain their original eight-service runtime profile and source/receipt semantics. The production eight-container guards in `staging_restore.py`, `cold_restore.py`, and related historical restoration components were not relaxed. A current ten-service candidate is not accepted as historical C07 evidence. Pending frontend SQL remains outside the legacy P1 release/admission path.

Live qualification remains required against exact candidate artifacts/configuration. Source preflight and readiness do not enable worker loops or establish whole producer/provider fencing.
