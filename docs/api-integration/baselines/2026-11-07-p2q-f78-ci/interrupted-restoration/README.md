# Owned interrupted-restoration checks

Both supported stop states passed at `abb491334041e8a58a53fa469451fe0070dc7863`. The fixture uses the actual B receipt writers, C retained reader, host broker, one-use authority, typed runtime and a new file lock. Each case passes five ordered stages for ten services and waits for the closure join and explicit commit before writing the terminal. The fixture supplies simulated Docker, provider, independent supervisor, frontend physical and API database transport. [Original result](host-composed.json) · [Runner](host-composed.py).

At `72be35dc16e1857ef2c2eee64e82f71b1c9ea326`, the original typed runtime refused both stop states before attempting any replacement. The guard's stop-all flow produced stopped containers while the runtime required running ones. The gateway-only control exposed a separate comparison against the original pre-stop PID. The fixture uses the real stop receipt and suspension source with simulated Docker. [Original refusals](repro-guard-stop.json) · [Runner](repro-guard-stop.py).

At `abb491334041e8a58a53fa469451fe0070dc7863`, the separate negative runner rejects changed configuration bytes, changed gateway lineage, a restarted service and a still-running old service before replacement. When the fresh frontend lease remains held after replacement, the join refuses and no terminal is published. [Negative results](host-negative.json) · [Runner](host-negative.py).

The separate frontend physical-session test at `72be35dc16e1857ef2c2eee64e82f71b1c9ea326` applied all 83 migrations to a disposable TLS PostgreSQL 18 database. It checked the fresh backend and advisory locks, the settled witness, refusal of drift, and independent closure after the session disconnected. The projected host composition and this PostgreSQL fixture establish separate boundaries. The installed Linux supervisor, profiled composition with all three databases and deployed staging remain open. [PostgreSQL record](frontend-physical.json).

Run each Python fixture against a separate empty directory populated with `git archive <exact-commit> ops`. The first argument is the archive directory. Both runners use disposable paths and fixed fixture values.

```sh
git archive abb491334041e8a58a53fa469451fe0070dc7863 ops | tar -xf - -C /absolute/owned-corrected-source
python3 -B host-composed.py /absolute/owned-corrected-source
python3 -B host-negative.py /absolute/owned-corrected-source
git archive 72be35dc16e1857ef2c2eee64e82f71b1c9ea326 ops | tar -xf - -C /absolute/owned-original-source
python3 -B repro-guard-stop.py /absolute/owned-original-source
```
