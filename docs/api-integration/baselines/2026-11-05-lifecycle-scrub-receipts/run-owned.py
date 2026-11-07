"""Run only the owned lifecycle database regressions; no ambient DB URL is read."""
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import urllib.parse

if len(sys.argv) != 1 or os.environ.get("LIFECYCLE_SCRUB_OWNED_TEST") != "true":
    raise SystemExit("EXPLICIT_OWNED_LIFECYCLE_SCRUB_TEST_REQUIRED")

root = Path(__file__).resolve().parents[4]
node = os.environ.get("NODE_BIN") or shutil.which("node")
if not node or not re.fullmatch(r"v24\.[0-9]+\.[0-9]+", subprocess.check_output([node, "--version"], text=True).strip()):
    raise SystemExit("NODE24_REQUIRED")
sys.path.insert(0, str(root / "ops/platform/host"))
import vercel_test  # noqa: E402
from frontend_crm_shipping_retirement_test import DatabaseRetirementTests as Fixture  # noqa: E402

# The owned CA binds both loopback names used by libpq and node-postgres. This
# keeps full chain/hostname validation enabled in both clients.
original_certificates = vercel_test.VercelControlTests.setUpClass.__func__


def certificates(cls):
    original_certificates(cls)
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
        "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", str(cls.key), "-out", str(cls.cert)],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


vercel_test.VercelControlTests.setUpClass = classmethod(certificates)
try:
    Fixture.setUpClass()
    # The fixture just created/migrated this isolated template. No configured
    # database, migration target or external address participates.
    Fixture.sql("CREATE DATABASE frontend_lifecycle_scrub_test TEMPLATE postgres;")
    ca = str(vercel_test.VercelControlTests.cert)
    url = ("postgresql://frontend_provider_fixture:" + urllib.parse.quote(Fixture.password, safe="") +
        "@127.0.0.1:" + str(Fixture.port) + "/frontend_lifecycle_scrub_test?sslmode=verify-full&sslrootcert=" + urllib.parse.quote(ca, safe=""))
    environment = {**Fixture.environment, "TEST_DATABASE_URL": url, "FRONTEND_WRITER_ADMISSION_MODE": "off",
        "NEXT_PUBLIC_SANITY_DATASET": "test-dataset", "NEXT_PUBLIC_SANITY_PROJECT_ID": "test-project", "NODE_EXTRA_CA_CERTS": ca}
    result = subprocess.run([node, "--import", str(root / "node_modules/tsx/dist/loader.mjs"),
        "--import", str(root / "scripts/register-server-only-test.mjs"), "--test", "--test-concurrency=1",
        str(root / "src/lib/customer-lifecycle/faults.db.test.ts"), str(root / "src/lib/customer-lifecycle/store.db.test.ts")],
        cwd=root, env=environment)
    print("OWNED_FIXTURE_MIGRATIONS=" + str(Fixture.migration_count), flush=True)
    raise SystemExit(result.returncode)
finally:
    Fixture.doClassCleanups()
