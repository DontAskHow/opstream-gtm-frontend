import importlib.util
import logging
from pathlib import Path
import unittest
from unittest.mock import Mock, patch


COMMON_PATH = Path(__file__).resolve().parents[2] / "refresh" / "brain-sync" / "common.py"
spec = importlib.util.spec_from_file_location("google_scope_common", COMMON_PATH)
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)

READONLY_GRANTS = (
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    "https://www.googleapis.com/auth/drive.metadata.readonly",
    "https://www.googleapis.com/auth/analytics.readonly",
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
)
WRITE_GRANT = "https://www.googleapis.com/auth/spreadsheets"
UNKNOWN_GRANT = "https://example.com/unapproved-scope"
MISSING = object()


class GoogleTokenScopes(unittest.TestCase):
    def setUp(self):
        common._TOKEN_CACHE.clear()
        self.secret_patch = patch.object(common, "_read_secret_string", return_value="synthetic-secret")
        self.secret_patch.start()
        self.addCleanup(self.secret_patch.stop)
        self.addCleanup(common._TOKEN_CACHE.clear)
        self.request = Mock(side_effect=AssertionError("unexpected transport call"))
        self.network_patch = patch.object(
            common.urllib.request, "urlopen", side_effect=AssertionError("network is forbidden")
        )
        self.network_patch.start()
        self.addCleanup(self.network_patch.stop)

    def credentials(self, grants=READONLY_GRANTS, token="synthetic-access", error=None):
        class Credentials:
            def __init__(self, **kwargs):
                self.scopes = kwargs["scopes"]
                self.token = None

            def refresh(self, request):
                if error is not None:
                    raise error
                self.token = token
                if grants is not MISSING:
                    self.granted_scopes = grants

        return Credentials

    def access(self, grants=READONLY_GRANTS, **kwargs):
        return common.google_access_token(
            credentials_cls=self.credentials(grants, **kwargs), request=self.request
        )

    def assert_reconnect(self, action):
        with self.assertRaises(common.NeedsConnection) as caught:
            action()
        self.assertRegex(str(caught.exception).lower(), r"reconnect")
        return caught.exception

    def test_exact_readonly_grants_return_access_token(self):
        self.assertEqual(self.access(), "synthetic-access")

    def test_readonly_subset_returns_access_token(self):
        self.assertEqual(self.access(READONLY_GRANTS[:1]), "synthetic-access")

    def test_reordered_duplicate_readonly_grants_return_access_token(self):
        grants = tuple(reversed(READONLY_GRANTS)) + READONLY_GRANTS[:1]
        self.assertEqual(self.access(grants), "synthetic-access")

    def test_write_grant_requires_reconnection(self):
        self.assert_reconnect(lambda: self.access(READONLY_GRANTS + (WRITE_GRANT,)))

    def test_gmail_send_grant_requires_reconnection(self):
        grants = READONLY_GRANTS + ("https://www.googleapis.com/auth/gmail.send",)
        self.assert_reconnect(lambda: self.access(grants))

    def test_unknown_grant_requires_reconnection(self):
        self.assert_reconnect(lambda: self.access(READONLY_GRANTS + (UNKNOWN_GRANT,)))

    def test_requested_write_scope_does_not_expand_allowlist(self):
        self.assert_reconnect(lambda: common.google_access_token(
            scopes=(WRITE_GRANT,), credentials_cls=self.credentials((WRITE_GRANT,)),
            request=self.request,
        ))

    def test_missing_grants_do_not_fall_back_to_requested_scopes(self):
        self.assert_reconnect(lambda: self.access(MISSING))

    def test_none_grants_require_reconnection(self):
        self.assert_reconnect(lambda: self.access(None))

    def test_empty_grants_require_reconnection(self):
        self.assert_reconnect(lambda: self.access(()))

    def test_rejected_grants_are_not_cached(self):
        self.assert_reconnect(lambda: self.access((WRITE_GRANT,), token="synthetic-unsafe-access"))
        self.assertEqual(self.access(token="synthetic-safe-access"), "synthetic-safe-access")

    def test_missing_grants_are_not_cached(self):
        self.assert_reconnect(lambda: self.access(MISSING, token="synthetic-unverified-access"))
        self.assertEqual(self.access(token="synthetic-safe-access"), "synthetic-safe-access")

    def test_validated_access_token_is_cached(self):
        self.assertEqual(self.access(), "synthetic-access")
        credentials = Mock(side_effect=AssertionError("validated token should be cached"))
        self.assertEqual(common.google_access_token(
            credentials_cls=credentials, request=self.request,
        ), "synthetic-access")

    def test_expired_cache_does_not_allow_unsafe_refresh(self):
        with patch.object(common.time, "time", return_value=1000):
            self.assertEqual(self.access(), "synthetic-access")
        with patch.object(common.time, "time", return_value=5000):
            self.assert_reconnect(lambda: self.access((WRITE_GRANT,)))

    def test_rejection_message_does_not_include_token_or_grants(self):
        token = "synthetic-private-access"
        error = self.assert_reconnect(lambda: self.access((UNKNOWN_GRANT,), token=token))
        self.assertNotIn(token, str(error))
        self.assertNotIn(UNKNOWN_GRANT, str(error))

    def test_provider_error_message_does_not_escape(self):
        provider_detail = "synthetic-provider-detail synthetic-private-access"
        with self.assertRaises(common.NeedsConnection) as caught:
            self.access(error=RuntimeError(provider_detail))
        self.assertNotIn(provider_detail, str(caught.exception))
        self.assertNotIn("synthetic-private-access", str(caught.exception))

    def test_scope_rejection_exits_three_without_success_or_watermark(self):
        log = logging.getLogger("synthetic-scope-test")
        log.addHandler(logging.NullHandler())
        outcome = Mock()
        watermark = Mock()

        def sync(_log):
            self.access((WRITE_GRANT,), token="synthetic-private-access")
            watermark("synthetic-success")
            return "synthetic-success"

        with patch.object(common, "setup_logger", return_value=log), patch.object(
            common, "record_outcome", outcome
        ), self.assertRaises(SystemExit) as caught:
            common.run_main("synthetic-source", sync)
        self.assertEqual(caught.exception.code, common.EXIT_NEEDS_CONNECTION)
        watermark.assert_not_called()
        outcome.assert_called_once()
        args = outcome.call_args.args
        self.assertEqual(args[:2], ("synthetic-source", False))
        self.assertIn("reconnect", args[-1].lower())
        self.assertNotIn("synthetic-private-access", args[-1])


if __name__ == "__main__":
    unittest.main()
