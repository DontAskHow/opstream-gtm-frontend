import importlib.util
import json
import logging
from pathlib import Path
from types import SimpleNamespace
import traceback
import unittest
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlencode


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
GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send"
UNKNOWN_GRANT = "https://example.com/unapproved-scope"
TOKEN_URI = "https://oauth2.googleapis.com/token"
PROBE_ACCESS = "synthetic-probe-access-never-use"
PROBE_ID = "synthetic-probe-id-never-use"
MISSING = object()


class FakeGoogleTransport:
    def __init__(self, grants=READONLY_GRANTS, token="synthetic-access",
                 probe_status=200, probe_data=MISSING):
        self.grants = grants
        self.token = token
        self.probe_status = probe_status
        self.probe_data = probe_data

    def __call__(self, url, method="GET", body=None, headers=None, **kwargs):
        form = parse_qs(body.decode() if isinstance(body, bytes) else body,
                        keep_blank_values=True)
        if "scope" not in form:
            if self.probe_data is not MISSING:
                return SimpleNamespace(status=self.probe_status, data=self.probe_data)
            payload = {"access_token": PROBE_ACCESS, "id_token": PROBE_ID}
            if self.grants is not MISSING:
                payload["scope"] = (" ".join(self.grants)
                                    if isinstance(self.grants, (tuple, list)) else self.grants)
            return SimpleNamespace(status=self.probe_status, data=json.dumps(payload).encode())
        requested = form["scope"][0].split()
        full_grants = self.grants if isinstance(self.grants, (tuple, list)) else ()
        narrowed = [scope for scope in requested if scope in full_grants]
        payload = {"access_token": self.token, "scope": " ".join(narrowed)}
        return SimpleNamespace(status=200, data=json.dumps(payload).encode())


class GoogleTokenScopes(unittest.TestCase):
    def setUp(self):
        common._TOKEN_CACHE.clear()
        self.secret_patch = patch.object(common, "_read_secret_string", return_value="synthetic-secret")
        self.secret_patch.start()
        self.addCleanup(self.secret_patch.stop)
        self.addCleanup(common._TOKEN_CACHE.clear)
        self.transport = FakeGoogleTransport()
        self.request = Mock(side_effect=lambda *args, **kwargs: self.transport(*args, **kwargs))
        self.network_patch = patch.object(
            common.urllib.request, "urlopen", side_effect=AssertionError("network is forbidden")
        )
        self.network_patch.start()
        self.addCleanup(self.network_patch.stop)

    def credentials(self, error=None, scoped_grants=MISSING):
        class Credentials:
            def __init__(self, **kwargs):
                self.options = kwargs
                self.token = None

            def refresh(self, request):
                if error is not None:
                    raise error
                response = request(
                    url=self.options["token_uri"], method="POST",
                    body=urlencode({
                        "refresh_token": self.options["refresh_token"],
                        "client_id": self.options["client_id"],
                        "client_secret": self.options["client_secret"],
                        "grant_type": "refresh_token",
                        "scope": " ".join(self.options["scopes"]),
                    }).encode(),
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                )
                payload = json.loads(response.data)
                self.token = payload["access_token"]
                self.granted_scopes = (payload["scope"].split()
                                       if scoped_grants is MISSING else scoped_grants)

        return Credentials

    def access(self, grants=READONLY_GRANTS, token="synthetic-access", error=None,
               scoped_grants=MISSING, scopes=None, **transport_options):
        self.transport = FakeGoogleTransport(grants, token, **transport_options)
        return common.google_access_token(
            scopes=scopes, credentials_cls=self.credentials(error, scoped_grants),
            request=self.request,
        )

    def assert_reconnect(self, action):
        with self.assertRaises(common.NeedsConnection) as caught:
            action()
        self.assertRegex(str(caught.exception).lower(), r"reconnect")
        return caught.exception

    def assert_refresh_calls(self, *scope_sets):
        self.assertEqual(len(self.request.call_args_list), len(scope_sets))
        for call, scopes in zip(self.request.call_args_list, scope_sets):
            url = call.kwargs.get("url", call.args[0] if call.args else None)
            self.assertEqual(url, TOKEN_URI)
            self.assertEqual(call.kwargs["method"], "POST")
            body = call.kwargs["body"]
            form = parse_qs(body.decode() if isinstance(body, bytes) else body,
                            keep_blank_values=True)
            expected = {"refresh_token": ["synthetic-secret"],
                        "client_id": ["synthetic-secret"],
                        "client_secret": ["synthetic-secret"],
                        "grant_type": ["refresh_token"]}
            if scopes is not None:
                expected["scope"] = [" ".join(scopes)]
            self.assertEqual(form, expected)
            headers = call.kwargs.get("headers") or {}
            self.assertFalse(any(key.lower() == "authorization" for key in headers))

    def test_exact_readonly_grants_return_access_token(self):
        self.assertEqual(self.access(), "synthetic-access")
        self.assert_refresh_calls(None, READONLY_GRANTS)

    def test_readonly_subset_returns_access_token(self):
        self.assertEqual(self.access(READONLY_GRANTS[:1]), "synthetic-access")
        self.assert_refresh_calls(None, READONLY_GRANTS)

    def test_reordered_duplicate_readonly_grants_return_access_token(self):
        grants = tuple(reversed(READONLY_GRANTS)) + READONLY_GRANTS[:1]
        self.assertEqual(self.access(grants), "synthetic-access")
        self.assert_refresh_calls(None, READONLY_GRANTS)

    def test_write_grant_requires_reconnection(self):
        self.assert_reconnect(lambda: self.access(READONLY_GRANTS + (WRITE_GRANT,)))
        self.assert_refresh_calls(None)

    def test_gmail_send_grant_requires_reconnection(self):
        self.transport = FakeGoogleTransport(READONLY_GRANTS + (GMAIL_SEND,))
        credentials = self.credentials()(
            token=None, refresh_token="synthetic-secret", client_id="synthetic-secret",
            client_secret="synthetic-secret", token_uri=TOKEN_URI, scopes=READONLY_GRANTS,
        )
        credentials.refresh(self.request)
        self.assertEqual(tuple(credentials.granted_scopes), READONLY_GRANTS)
        self.assertEqual(credentials.token, "synthetic-access")
        self.assert_refresh_calls(READONLY_GRANTS)

        self.request.reset_mock()
        self.assert_reconnect(lambda: self.access(READONLY_GRANTS + (GMAIL_SEND,)))
        self.assertFalse(common._TOKEN_CACHE)
        self.assert_refresh_calls(None)

    def test_other_write_grants_require_reconnection(self):
        for grant in ("https://www.googleapis.com/auth/drive",
                      "https://www.googleapis.com/auth/gmail.compose",
                      "https://www.googleapis.com/auth/gmail.modify"):
            with self.subTest(grant=grant):
                self.request.reset_mock()
                self.assert_reconnect(lambda: self.access(READONLY_GRANTS + (grant,)))
                self.assert_refresh_calls(None)

    def test_unknown_grant_requires_reconnection(self):
        self.assert_reconnect(lambda: self.access(READONLY_GRANTS + (UNKNOWN_GRANT,)))
        self.assert_refresh_calls(None)

    def test_requested_write_scope_does_not_expand_allowlist(self):
        self.assert_reconnect(lambda: self.access(
            READONLY_GRANTS + (WRITE_GRANT,), scopes=READONLY_GRANTS + (WRITE_GRANT,)))
        self.assert_refresh_calls(None)

    def test_caller_subset_does_not_shrink_fixed_allowlist(self):
        self.assertEqual(self.access(scopes=READONLY_GRANTS[:1]), "synthetic-access")
        self.assert_refresh_calls(None, READONLY_GRANTS[:1])

    def test_missing_grants_do_not_fall_back_to_requested_scopes(self):
        self.assert_reconnect(lambda: self.access(MISSING))
        self.assert_refresh_calls(None)

    def test_none_grants_require_reconnection(self):
        self.assert_reconnect(lambda: self.access(None))
        self.assert_refresh_calls(None)

    def test_empty_grants_require_reconnection(self):
        for grants in ((), "", "   "):
            with self.subTest(grants=grants):
                self.request.reset_mock()
                self.assert_reconnect(lambda: self.access(grants))
                self.assert_refresh_calls(None)

    def test_nonstring_probe_scope_requires_reconnection(self):
        for scope in (list(READONLY_GRANTS), {}, 1, True):
            with self.subTest(scope=scope):
                self.request.reset_mock()
                data = json.dumps({"scope": scope, "access_token": PROBE_ACCESS}).encode()
                self.assert_reconnect(lambda: self.access(probe_data=data))
                self.assert_refresh_calls(None)

    def test_invalid_probe_response_requires_reconnection(self):
        for status, data in ((400, b'{"scope":"openid"}'),
                             (500, b'{"scope":"openid"}'),
                             (200, b'synthetic-not-json'),
                             (200, b'[]'), (200, b'null'), (200, b'"openid"')):
            with self.subTest(status=status, data=data):
                self.request.reset_mock()
                self.assert_reconnect(lambda: self.access(probe_status=status, probe_data=data))
                self.assert_refresh_calls(None)

    def test_probe_transport_error_does_not_escape_or_cache_tokens(self):
        provider_detail = PROBE_ACCESS + " " + PROBE_ID
        self.request.side_effect = RuntimeError(provider_detail)
        with self.assertRaises(common.NeedsConnection) as caught:
            self.access()
        rendered = "".join(traceback.format_exception(caught.exception))
        for secret in (PROBE_ACCESS, PROBE_ID):
            self.assertNotIn(secret, rendered)
        self.assertIn("reconnect", str(caught.exception).lower())
        self.assertFalse(common._TOKEN_CACHE)
        self.assert_refresh_calls(None)

    def test_post_refresh_scope_check_remains_required(self):
        for grants in (None, (), (WRITE_GRANT,)):
            with self.subTest(grants=grants):
                self.request.reset_mock()
                self.assert_reconnect(lambda: self.access(scoped_grants=grants))
                self.assert_refresh_calls(None, READONLY_GRANTS)

    def test_rejected_grants_are_not_cached(self):
        self.assert_reconnect(lambda: self.access((WRITE_GRANT,), token="synthetic-unsafe-access"))
        self.assertFalse(common._TOKEN_CACHE)
        self.assertEqual(self.access(token="synthetic-safe-access"), "synthetic-safe-access")
        self.assert_refresh_calls(None, None, READONLY_GRANTS)

    def test_missing_grants_are_not_cached(self):
        self.assert_reconnect(lambda: self.access(MISSING, token="synthetic-unverified-access"))
        self.assertFalse(common._TOKEN_CACHE)
        self.assertEqual(self.access(token="synthetic-safe-access"), "synthetic-safe-access")
        self.assert_refresh_calls(None, None, READONLY_GRANTS)

    def test_validated_access_token_is_cached(self):
        self.assertEqual(self.access(), "synthetic-access")
        self.request.reset_mock()
        credentials = Mock(side_effect=AssertionError("validated token should be cached"))
        self.assertEqual(common.google_access_token(
            credentials_cls=credentials, request=self.request,
        ), "synthetic-access")
        self.request.assert_not_called()
        credentials.assert_not_called()

    def test_expired_cache_does_not_allow_unsafe_refresh(self):
        with patch.object(common.time, "time", return_value=1000):
            self.assertEqual(self.access(), "synthetic-access")
        self.assert_refresh_calls(None, READONLY_GRANTS)
        self.request.reset_mock()
        with patch.object(common.time, "time", return_value=5000):
            self.assert_reconnect(lambda: self.access(READONLY_GRANTS + (GMAIL_SEND,)))
        self.assert_refresh_calls(None)

    def test_each_expired_readonly_refresh_probes_again(self):
        with patch.object(common.time, "time", return_value=1000):
            self.assertEqual(self.access(), "synthetic-access")
        with patch.object(common.time, "time", return_value=5000):
            self.assertEqual(self.access(token="synthetic-fresh-access"), "synthetic-fresh-access")
        self.assert_refresh_calls(None, READONLY_GRANTS, None, READONLY_GRANTS)

    def test_rejection_message_does_not_include_token_or_grants(self):
        token = "synthetic-private-access"
        error = self.assert_reconnect(lambda: self.access((UNKNOWN_GRANT,), token=token))
        for secret in (token, UNKNOWN_GRANT, PROBE_ACCESS, PROBE_ID):
            self.assertNotIn(secret, str(error))
        self.assertFalse(common._TOKEN_CACHE)

    def test_provider_error_message_does_not_escape(self):
        provider_detail = "synthetic-provider-detail synthetic-private-access"
        with self.assertRaises(common.NeedsConnection) as caught:
            self.access(error=RuntimeError(provider_detail))
        self.assertNotIn(provider_detail, str(caught.exception))
        self.assertNotIn("synthetic-private-access", str(caught.exception))

    def test_readonly_run_main_uses_only_narrowed_token(self):
        log = logging.getLogger("synthetic-readonly-success")
        outcome = Mock()
        watermark = Mock()
        sent_headers = []

        class ApiResponse:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return b'{"synthetic":"ok"}'

        def api_request(req, **kwargs):
            sent_headers.append(dict(req.header_items()))
            return ApiResponse()

        returned_tokens = []

        def get_token(*args):
            token = self.access()
            returned_tokens.append(token)
            return token

        def sync(_log):
            common.authed_request("GET", "https://example.com/synthetic-readonly",
                                  ["synthetic-source"], ["example.com"])
            watermark("synthetic-success")
            return "synthetic-success"

        with patch.object(common, "setup_logger", return_value=log), patch.object(
            common, "record_outcome", outcome
        ), patch.object(common, "access_token_for", side_effect=get_token), patch.object(
            common.urllib.request, "urlopen", side_effect=api_request
        ), self.assertLogs(level="INFO") as logs, self.assertRaises(SystemExit) as caught:
            common.run_main("synthetic-source", sync)
        self.assertEqual(caught.exception.code, common.EXIT_OK)
        watermark.assert_called_once_with("synthetic-success")
        outcome.assert_called_once_with("synthetic-source", True, None, None, "synthetic-success")
        self.assertEqual(returned_tokens, ["synthetic-access"])
        self.assertEqual(len(sent_headers), 1)
        self.assertEqual(sent_headers[0]["Authorization"], "Bearer synthetic-access")
        self.assert_refresh_calls(None, READONLY_GRANTS)
        observed = repr((returned_tokens, common._TOKEN_CACHE, sent_headers,
                         self.request.call_args_list, outcome.call_args_list, logs.output))
        for secret in (PROBE_ACCESS, PROBE_ID):
            self.assertNotIn(secret, observed)

    def test_scope_rejection_exits_three_without_success_or_watermark(self):
        log = logging.getLogger("synthetic-scope-test")
        outcome = Mock()
        watermark = Mock()

        def sync(_log):
            self.access(READONLY_GRANTS + (GMAIL_SEND,), token="synthetic-private-access")
            watermark("synthetic-success")
            return "synthetic-success"

        with patch.object(common, "setup_logger", return_value=log), patch.object(
            common, "record_outcome", outcome
        ), self.assertLogs(level="INFO") as logs, self.assertRaises(SystemExit) as caught:
            common.run_main("synthetic-source", sync)
        self.assertEqual(caught.exception.code, common.EXIT_NEEDS_CONNECTION)
        watermark.assert_not_called()
        outcome.assert_called_once()
        args = outcome.call_args.args
        self.assertEqual(args[:2], ("synthetic-source", False))
        self.assertIn("reconnect", args[-1].lower())
        observed = repr((args, str(caught.exception), logs.output, common._TOKEN_CACHE,
                         self.request.call_args_list))
        for secret in ("synthetic-private-access", PROBE_ACCESS, PROBE_ID):
            self.assertNotIn(secret, observed)
        self.assertFalse(common._TOKEN_CACHE)
        self.assert_refresh_calls(None)


if __name__ == "__main__":
    unittest.main()
