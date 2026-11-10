# Owned interrupted-restoration checks

Both supported stop states passed at `abb491334041e8a58a53fa469451fe0070dc7863`. The fixture uses the actual B receipt writers, C retained reader, host broker, one-use authority, typed runtime and a new file lock. Each case passes five ordered stages for ten services and waits for the closure join and explicit commit before writing the terminal. The fixture supplies simulated Docker, provider, independent supervisor, frontend physical and API database transport. [Original result](host-composed.json) · [Runner](host-composed.py).

At `72be35dc16e1857ef2c2eee64e82f71b1c9ea326`, the original typed runtime refused both stop states before attempting any replacement. The guard's stop-all flow produced stopped containers while the runtime required running ones. The gateway-only control exposed a separate comparison against the original pre-stop PID. The fixture uses the real stop receipt and suspension source with simulated Docker. [Original refusals](repro-guard-stop.json) · [Runner](repro-guard-stop.py).

At `abb491334041e8a58a53fa469451fe0070dc7863`, the separate negative runner rejects changed configuration bytes, changed gateway lineage, a restarted service and a still-running old service before replacement. When the fresh frontend lease remains held after replacement, the join refuses and no terminal is published. [Negative results](host-negative.json) · [Runner](host-negative.py).

The separate frontend physical-session test at `72be35dc16e1857ef2c2eee64e82f71b1c9ea326` applied all 83 migrations to a disposable TLS PostgreSQL 18 database. It checked the fresh backend and advisory locks, the settled witness, refusal of drift, and independent closure after the session disconnected. The projected host composition and this PostgreSQL fixture establish separate boundaries. The installed Linux supervisor, profiled composition with all three databases and deployed staging remain open. [PostgreSQL record](frontend-physical.json).

Two additional controls used the exact `abb49133` source. The frontend bridge ran the production Python observer and separate fixed Node CLI against the live disposable TLS frontend database. It rejected closure while the source backend held its locks and verified absence of the backend and both locks after disconnect. The API control ran the fixed host read-only checker and exact Course `0bb054d5` and Community `8594d953` validators against a separate disposable TLS PostgreSQL 18 cluster. It applied 83/22/11 migrations, refused actual role configuration drift, and verified unchanged journals after the repaired reads. Both controls projected the Docker launcher. [Frontend bridge](frontend-host-bridge.json) · [API current checks](profiled-api-current.json).

Run each Python fixture against a separate empty directory populated with `git archive <exact-commit> ops`. The first argument is the archive directory. Both runners use disposable paths and fixed fixture values.

```sh
git archive abb491334041e8a58a53fa469451fe0070dc7863 ops | tar -xf - -C /absolute/owned-corrected-source
python3 -B host-composed.py /absolute/owned-corrected-source
python3 -B host-negative.py /absolute/owned-corrected-source
git archive 72be35dc16e1857ef2c2eee64e82f71b1c9ea326 ops | tar -xf - -C /absolute/owned-original-source
python3 -B repro-guard-stop.py /absolute/owned-original-source
```

For the TLS controls, extract `ops`, `src`, `drizzle`, `scripts`, `contracts` and `tsconfig.json` from exact `abb491334041e8a58a53fa469451fe0070dc7863` into the corrected archive. Use the frontend migration image package metadata from `ops/platform/frontend-migration-deps/package.json` as its root package file, with its pinned pg and Drizzle dependencies installed. Use Node 24.18.0 and PostgreSQL 18.6. Set `PG_BIN` to the PostgreSQL bin directory and `OWNED_POSTGRES_MAJOR=18`. For the API command, set `P2_KNOWN_ACK_COURSE_SOURCE_ROOT` and `P2_KNOWN_ACK_COMMUNITY_SOURCE_ROOT` to clean checkouts of the exact API sources with their dependencies installed.

```sh
python3 -B build-physical-bridge.py /absolute/owned-corrected-source ./physical-host-generated.mjs
P2_CERTIFICATION_OWNED_TEST=true node physical-host-generated.mjs
python3 -B build-profiled-api.py /absolute/owned-corrected-source ./profiled-api-generated.mjs
P2_KNOWN_ACK_OWNED_TEST=true node --import tsx profiled-api-generated.mjs
```
