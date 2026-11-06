#!/usr/bin/env python3
"""Fixed recovery dispatch; no JSON-selectable executor, lock or observer path."""
import json
from pathlib import Path
import signal
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from p2_release_supervisor import supervise, MAXIMUM
from p2_recovery_broker import P2RecoveryBroker, P2RecoveryPhysicalObserver
import migrate

LAYOUT = {'actionIdKey':'recoveryActionId','receiptPrefix':'p2-recovery-','runtimePrefix':'runtime-recovery-',
          'terminalName':'p2-recovery-outcome.json','terminalStatus':'P2_STAGING_RECOVERY_RESTORATION_VERIFIED'}


def main():
    raw = sys.stdin.buffer.readline(MAXIMUM + 1)
    migrate.demand(0 < len(raw) <= MAXIMUM and raw.endswith(b'\n'),'P2_RECOVERY_INITIAL_INPUT_REFUSED')
    initial = json.loads(raw)
    migrate.demand(initial.get('mode') == 'p2-post-sql-recovery','P2_RECOVERY_FIXED_MODE_REQUIRED')
    # Added by the shared driver owner. Until that version is installed, Python
    # rejects these fixed source arguments before any runtime/startup authority.
    supervise(initial, broker_type=P2RecoveryBroker, observer_type=P2RecoveryPhysicalObserver,
              observer_source='ops/platform/p2-recovery-current-probe.mjs', layout=LAYOUT)


if __name__ == '__main__':
    for item, code in ((signal.SIGTERM,143),(signal.SIGHUP,129),(signal.SIGINT,130)):
        signal.signal(item,lambda *_args,code=code: (_ for _ in ()).throw(SystemExit(code)))
    try:
        main()
    except BaseException:
        print('P2_POST_SQL_RECOVERY_FAILED_REQUIRES_REVIEW',file=sys.stderr)
        raise SystemExit(1)
