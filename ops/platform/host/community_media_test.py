from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import tempfile
import unittest

import community_media as media


class MediaSessionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.sessions = self.root / "staging"
        self.sessions.mkdir(mode=0o700)
        for role in media.ROLE_NAMES:
            child = self.sessions / role
            child.mkdir(mode=0o750)
            if os.getuid() == 0:
                os.chown(child, 0, 65532)
        self.value = {"environment": "staging", "accountId": "123456789012",
                      "region": "us-east-1", "bucket": "lash-community-staging-123456789012-us-east-1",
                      "databaseNetwork": "test_community_database", "sessionsDirectory": str(self.sessions),
                      "roles": {role: f"arn:aws:iam::123456789012:role/fixture-{role}" for role in media.ROLE_NAMES}}
        self.now = datetime(2026, 11, 17, tzinfo=timezone.utc)

    def issued(self, role, generation=1, minutes=30):
        return {"roleArn": self.value["roles"][role], "session": {
            "Version": 1, "AccessKeyId": f"synthetic-{role}-{generation}", "SecretAccessKey": "synthetic",
            "SessionToken": "synthetic-token",
            "Expiration": (self.now + timedelta(minutes=minutes)).isoformat().replace("+00:00", "Z")}}

    def test_rotation_updates_the_same_directory_without_replacing_credentials_for_the_other_role(self):
        initial = self.issued("api")
        worker = self.issued("worker")
        media.publish_session(self.value, "api", initial, self.now)
        media.publish_session(self.value, "worker", worker, self.now)
        media.preflight_sessions(self.value, self.now)
        previous = (self.sessions / "api/session.json").open("rb")
        try:
            fresh = self.issued("api", generation=2, minutes=45)
            media.publish_session(self.value, "api", fresh, self.now)
            self.assertEqual(json.load(previous), initial["session"])
            self.assertEqual(media.session_value(self.sessions / "api"), fresh["session"])
            self.assertEqual(media.session_value(self.sessions / "worker"), worker["session"])
            self.assertEqual(list((self.sessions / "api").glob(".session-*")), [])
            with self.assertRaisesRegex(ValueError, "MEDIA_STALE_SESSION_REFUSED"):
                media.publish_session(self.value, "api", initial, self.now)
        finally:
            previous.close()

    def test_rejects_cross_role_and_near_expiry_sessions_before_writing(self):
        with self.assertRaisesRegex(ValueError, "MEDIA_ISSUER_ROLE_REFUSED"):
            media.publish_session(self.value, "api", self.issued("worker"), self.now)
        with self.assertRaisesRegex(ValueError, "MEDIA_SESSION_TOO_CLOSE_TO_EXPIRY"):
            media.publish_session(self.value, "api", self.issued("api", minutes=5), self.now)
        self.assertFalse((self.sessions / "api/session.json").exists())

    def test_cross_environment_media_binding_is_refused(self):
        (self.root / "media.json").write_text(json.dumps(self.value))
        self.assertEqual(media.settings(self.root, "staging"), self.value)
        with self.assertRaisesRegex(ValueError, "MEDIA_ENVIRONMENT_BINDING_REFUSED"):
            media.settings(self.root, "production")
        self.value["bucket"] = self.value["bucket"].replace("staging", "production")
        (self.root / "media.json").write_text(json.dumps(self.value))
        with self.assertRaisesRegex(ValueError, "MEDIA_TARGET_BINDING_REFUSED"):
            media.settings(self.root, "staging")
