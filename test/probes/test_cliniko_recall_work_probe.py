"""Failure-path cleanup for the owner-only Cliniko recall lifecycle probe."""

import io
import os
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch
from urllib.error import URLError
from urllib.parse import parse_qs, urlsplit


PROBES = Path(__file__).resolve().parents[2] / "phase-0" / "probes"
sys.path.insert(0, str(PROBES))
import cliniko_recall_work_probe as probe  # noqa: E402


class FakeCliniko:
    def __init__(self, type_failure: str | None):
        self.type_failure = type_failure
        self.recall_type = None
        self.type_archives = 0
        self.patient_posts = 0

    def request(self, _base, _headers, method, path, body=None):
        route = urlsplit(path)
        if method == "GET" and route.path == "/recall_types":
            archived = "archived_at:*" in parse_qs(route.query).get("q[]", [])
            rows = [self.recall_type] if self.recall_type and bool(self.recall_type["archived_at"]) == archived else []
            return 200, {"total_entries": len(rows), "recall_types": rows}
        if method == "POST" and route.path == "/recall_types":
            assert body and body["default_duration"] == 1 and body["default_duration_type"] == 10
            self.recall_type = {"id": "91", "name": body["name"], "archived_at": None}
            if self.type_failure == "lost":
                raise URLError("synthetic lost type response")
            if self.type_failure == "serverError":
                return 500, {}
            return 201, self.recall_type
        if method == "GET" and route.path == "/recall_types/91":
            return 200, self.recall_type
        if method == "POST" and route.path == "/recall_types/91/archive":
            self.type_archives += 1
            self.recall_type = {**self.recall_type, "archived_at": "2026-10-02T00:00:00Z"}
            return 204, {}
        if method == "POST" and route.path == "/patients":
            self.patient_posts += 1
            return 422, {}
        raise AssertionError(f"unexpected synthetic request: {method} {route.path}")


class RecallProbeCleanupTest(unittest.TestCase):
    def run_failure(self, type_failure: str | None):
        provider = FakeCliniko(type_failure)
        environment = {"ABBY_LIVE_CLINIKO_EVAL": "1", "ABBY_CLINIKO_API_KEY": "synthetic-key-au5",
                       "ABBY_CLINIKO_CONTACT_EMAIL": "test@example.com"}
        with patch.dict(os.environ, environment), patch.object(probe, "request", provider.request), \
                patch.object(probe, "exact_patient", return_value=(None, 0)), \
                patch.object(probe, "writer_probe", side_effect=AssertionError("recall write must not run")), \
                redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(probe.main(), 1)
        self.assertIsNotNone(provider.recall_type)
        self.assertIsNotNone(provider.recall_type["archived_at"])
        self.assertEqual(provider.type_archives, 1)
        self.assertEqual(provider.patient_posts, 0 if type_failure else 1)

    def test_archives_created_type_after_patient_create_is_rejected(self):
        self.run_failure(None)

    def test_finds_and_archives_type_after_create_response_is_lost(self):
        self.run_failure("lost")

    def test_finds_and_archives_type_after_create_returns_server_error(self):
        self.run_failure("serverError")


if __name__ == "__main__":
    unittest.main()
