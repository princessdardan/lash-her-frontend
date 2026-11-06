# Single recovery qualification receipt

The required CI helper accepts exactly one closed stdout receipt. The earlier owned wrapper forwarded two Node progress JSON records before its final receipt, so valid fixture execution could not satisfy that contract.

The Node fixture now emits only its one source receipt. Named failing cases remain assertion diagnostics. Python captures the complete child output privately, requires one exact source receipt, joins its actual poisoned-environment/sentinel checks and emits one final OWNED_P2_RECOVERY_DATABASE_CHECKS_PASS line. Child failure emits a fixed sanitized error and no success receipt. The helper contract is unchanged; no progress-record allowlist or optional skip was added.

Actual owned TLS PostgreSQL16 execution passed55 groups,39 named cases,83/22/11 migrations and the environment checks. The captured output has exactly one line and stderr is empty. PostgreSQL18 CI remains separate. No provider/live operation or SQL replay occurred. This commit changes the fixture protocol only; forward mode is still open.
