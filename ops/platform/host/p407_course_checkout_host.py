"""Candidate-only fixture and loopback gateway admission operator."""
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path("/var/lib/lash-her/p4-07")
DATABASE_CONTAINER = "lash-her-p4-07-postgres"
GATEWAY = "lash-her-p4-07-course-gateway-1"
GATE = ROOT / "course-runtime/admission/state.json"
CURRENT_RECEIPT = "43db9dc5a47c9eeb63ee22d6dabc8111296aa8f826b6e2bc2f7515edeae7bba2"
FRONTEND = "lash_her_p407_frontend"
COURSE = "lash_her_p407_course"
UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")
GATE_JS = ("fetch('http://127.0.0.1:9100/admission',{signal:AbortSignal.timeout(3000)})"
           ".then(r=>r.json()).then(o=>console.log(JSON.stringify(o)))")


def require(condition, code):
    if not condition:
        raise ValueError(code)


def docker(*args, data=None):
    result = subprocess.run(["docker", *args], input=data, text=True, capture_output=True, timeout=20)
    require(result.returncode == 0, "P407_HOST_COMMAND_REFUSED")
    return result.stdout.strip()


def sql(database, query, **variables):
    require(database in (FRONTEND, COURSE), "P407_TARGET_REFUSED")
    options = [f"--set={key}={value}" for key, value in variables.items()]
    return docker("exec", "-i", "-u", "postgres", DATABASE_CONTAINER, "psql", "-XAtq", "--set=ON_ERROR_STOP=1",
                  "--set=VERBOSITY=sqlstate", "-d", database, *options, data=query)


def host_identity():
    require(os.getuid() == 0 and Path("/etc/machine-id").read_text().strip() == "ec2146be041cf26fda0a7986db4be3b6",
            "P407_HOST_IDENTITY_REFUSED")
    require(docker("inspect", "--format",
                   '{{index .Config.Labels "lash.candidate"}} {{.State.Running}} {{.HostConfig.NetworkMode}}',
                   DATABASE_CONTAINER) == "p4-07 true lash-her-p4-07-db", "P407_DATABASE_RUNTIME_REFUSED")
    require(not docker("port", DATABASE_CONTAINER) and
            docker("network", "inspect", "--format", "{{.Internal}}", "lash-her-p4-07-db") == "true",
            "P407_PUBLIC_DATABASE_REFUSED")
    require(docker("port", GATEWAY, "8443/tcp") == "127.0.0.1:8443" and
            docker("inspect", "--format", "{{.State.Health.Status}}", GATEWAY) == "healthy",
            "P407_PRIVATE_GATEWAY_REFUSED")


def read_review(needs_session=False):
    text = sys.stdin.read(1025)
    require(len(text) <= 1024, "P407_FIXTURE_INPUT_REFUSED")
    review = json.loads(text)
    require(isinstance(review, dict), "P407_FIXTURE_INPUT_REFUSED")
    required = {"sourceCommit", "orderId", "customerId", "courseId", "expiresAt", "producer"}
    require(set(review) == required | ({"sessionSha256"} if needs_session else set()),
            "P407_FIXTURE_INPUT_REFUSED")
    for key in ("orderId", "customerId", "courseId"):
        require(isinstance(review[key], str) and UUID.fullmatch(review[key]), "P407_FIXTURE_UUID_REFUSED")
    for key, length in (("sourceCommit", 40), ("producer", 64), ("sessionSha256", 64)):
        if key in review:
            value = review[key]
            require(isinstance(value, str) and re.fullmatch(rf"[a-f0-9]{{{length}}}", value) and value != "0" * length,
                    "P407_FIXTURE_DIGEST_REFUSED")
    expiry = dt.datetime.fromisoformat(review["expiresAt"])
    now = dt.datetime.now(dt.timezone.utc)
    require(expiry.utcoffset() == dt.timedelta() and expiry <= now + dt.timedelta(hours=2),
            "P407_FIXTURE_EXPIRY_REFUSED")
    return review


def ledger(review):
    result = sql(FRONTEND, """BEGIN READ ONLY;
SELECT json_build_object('phase', w.phase, 'expiresAt', w.expires_at,
  'current', COALESCE(w.expires_at > clock_timestamp(), false),
  'newWork', c.new_work, 'recovery', c.recovery, 'producerEnabled', p.enabled)
FROM frontend_admission.p407_window w CROSS JOIN frontend_admission.control c
JOIN frontend_admission.producers p ON p.source_sha = :'source' AND p.producer_sha256 = :'producer'
WHERE w.singleton AND c.singleton AND c.environment = 'staging' AND w.order_id = :'order_id'::uuid;
ROLLBACK;
""", source=review["sourceCommit"], producer=review["producer"], order_id=review["orderId"])
    return json.loads(result)


def seed(review):
    state = ledger(review)
    require(state["phase"] == "held" and not any(state[key] for key in ("newWork", "recovery", "producerEnabled")),
            "P407_FIXTURE_REQUIRES_HELD_LEDGER")
    require(dt.datetime.fromisoformat(review["expiresAt"]) > dt.datetime.now(dt.timezone.utc), "P407_FIXTURE_EXPIRED")
    course = sql(COURSE, r"""BEGIN;
SELECT current_database()='lash_her_p407_course' AS correct \gset
\if :correct
INSERT INTO public.courses (id,slug,title,introduction,price_cents,currency,access_mode,status,revision,tax_classification)
VALUES (:'course_id','p407-sandbox-checkout-fixture','P4-07 Checkout Fixture','Synthetic checkout rehearsal.',10000,'CAD','paid','published',3,'fixture-course')
ON CONFLICT (id) DO NOTHING;
SELECT (count(*)=1) AS correct FROM public.courses WHERE id=:'course_id'::uuid AND
 slug='p407-sandbox-checkout-fixture' AND price_cents=10000 AND currency='CAD' AND access_mode='paid'
 AND status='published' AND revision=3 AND tax_classification='fixture-course' \gset
\endif
\if :correct
COMMIT;
SELECT 'fixture_course_ready';
\else
ROLLBACK;
\endif
""", course_id=review["courseId"])
    require(course == "fixture_course_ready", "P407_FIXTURE_COURSE_REFUSED")
    frontend = sql(FRONTEND, r"""BEGIN;
SELECT current_database()='lash_her_p407_frontend' AND
 (SELECT count(*) FROM public.course_purchase_orders)=0 AS correct \gset
\if :correct
INSERT INTO public.customer_users (id,email,email_verified,name,status)
VALUES (:'customer_id','p407-rehearsal-' || :'customer_id' || '@example.invalid',clock_timestamp(),'P4-07 Fixture','active')
ON CONFLICT (id) DO NOTHING;
SELECT count(*)=1 AS correct FROM public.customer_users WHERE id=:'customer_id'::uuid
 AND email='p407-rehearsal-' || :'customer_id' || '@example.invalid' AND status='active' \gset
\endif
\if :correct
INSERT INTO public.customer_sessions(token_hash,user_id,expires)
VALUES (:'session_sha',:'customer_id',LEAST(:'expires_at'::timestamptz,clock_timestamp()+interval '30 minutes'))
ON CONFLICT (token_hash) DO NOTHING;
SELECT count(*)=1 AS correct FROM public.customer_sessions WHERE token_hash=:'session_sha'
 AND user_id=:'customer_id'::uuid AND expires>clock_timestamp() \gset
\endif
\if :correct
COMMIT;
SELECT 'fixture_session_ready';
\else
ROLLBACK;
\endif
""", customer_id=review["customerId"], session_sha=review["sessionSha256"], expires_at=review["expiresAt"])
    require(frontend == "fixture_session_ready", "P407_FIXTURE_CUSTOMER_REFUSED")
    return {"status": "P407_SYNTHETIC_FIXTURES_READY", "courseId": review["courseId"], "customerId": review["customerId"]}


def expire_session(review):
    state = ledger(review)
    require(state["phase"] == "closed" and not state["producerEnabled"], "P407_FIXTURE_REQUIRES_CLOSED_LEDGER")
    result = sql(FRONTEND, """WITH removed AS (
 DELETE FROM public.customer_sessions WHERE token_hash=:'session_sha' AND user_id=:'customer_id'::uuid RETURNING 1
) SELECT count(*) FROM removed;
""", customer_id=review["customerId"], session_sha=review["sessionSha256"])
    return {"status": "P407_SYNTHETIC_SESSION_CLOSED", "removed": int(result)}


def gateway_admission(open_recovery, review=None):
    observed = json.loads(docker("exec", GATEWAY, "node", "-e", GATE_JS))
    require(observed["valid"] and not observed["newWork"] and observed["candidateSha256"] == CURRENT_RECEIPT and
            observed["releaseId"] == "p4-07-relay-0146199", "P407_GATEWAY_RECEIPT_REFUSED")
    if open_recovery:
        state = ledger(review)
        require(state["phase"] == "recovery" and state["producerEnabled"] and state["current"] and
                not state["newWork"] and not observed["recovery"] and
                observed["active"]["recovery"] == observed["uncertain"]["recovery"] == 0,
                "P407_GATEWAY_REQUIRES_RECOVERY_ONLY")
    require(GATE.is_file() and not GATE.is_symlink() and GATE.stat().st_uid == 0, "P407_GATEWAY_FILE_REFUSED")
    current = json.loads(GATE.read_text())
    require(current["candidateSha256"] == CURRENT_RECEIPT and current["environment"] == "staging" and
            current["version"] == 1 and not current["newWork"], "P407_GATEWAY_FILE_REFUSED")
    current["recovery"] = open_recovery
    current["actionId"] = "p407-one-order-recovery" if open_recovery else "p407-course-held"
    with tempfile.NamedTemporaryFile(mode="w", dir=GATE.parent, delete=False) as staged:
        json.dump(current, staged)
        staged.write("\n")
        staged.flush()
        os.fsync(staged.fileno())
        pending = Path(staged.name)
    try:
        pending.chmod(0o444)
        pending.replace(GATE)
    finally:
        pending.unlink(missing_ok=True)
    final = json.loads(docker("exec", GATEWAY, "node", "-e", GATE_JS))
    require(final["valid"] and not final["newWork"] and final["recovery"] == open_recovery,
            "P407_GATEWAY_CHANGE_UNVERIFIED")
    return {"status": "P407_PRIVATE_GATEWAY_STATE_VERIFIED", "newWork": False, "recovery": open_recovery,
            "active": final["active"], "uncertain": final["uncertain"]}


def main():
    (mode,) = sys.argv[1:]
    require(mode in ("seed", "expire-session", "gateway-recovery", "gateway-close"), "P407_MODE_REFUSED")
    host_identity()
    with open("/run/lock/lash-her-release.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if mode == "gateway-close":
            value = gateway_admission(False)
        elif mode == "gateway-recovery":
            value = gateway_admission(True, read_review())
        elif mode == "seed":
            value = seed(read_review(needs_session=True))
        else:
            value = expire_session(read_review(needs_session=True))
        print(json.dumps(value))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        message = str(error)
        sys.exit(message if re.fullmatch(r"P407_[A-Z0-9_]+", message) else "P407_HOST_OPERATOR_REFUSED")
