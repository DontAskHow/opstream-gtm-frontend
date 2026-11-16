"""align-run.py writes commitMonth and its definition on run-facts.json.

The collection month is the same YYYY-MM already stored on agent-brief.json.
Synthetic companies, amounts and dates only.

    python3 -m unittest scripts/tests/test_align_run.py
"""
import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent


def _load_align_run(data_dir):
    # Sibling modules that ship in the sync image but are not in this public repo.
    if "source_health" not in sys.modules:
        source_health = types.ModuleType("source_health")
        source_health.insights = lambda sources: []
        sys.modules["source_health"] = source_health
    if "draft_seeds" not in sys.modules:
        draft_seeds = types.ModuleType("draft_seeds")
        draft_seeds.build = lambda *args, **kwargs: []
        sys.modules["draft_seeds"] = draft_seeds
    os.environ["OUT_DATA"] = str(data_dir)
    spec = importlib.util.spec_from_file_location(
        "align_run", str(SCRIPTS / "align-run.py"))
    mod = importlib.util.module_from_spec(spec)
    # scripts/ is already on the path after exec; keep a unique module name.
    sys.modules["align_run"] = mod
    spec.loader.exec_module(mod)
    mod.DATA = Path(data_dir)
    return mod


def _write(path, value):
    Path(path).write_text(json.dumps(value), encoding="utf-8")


def _fake_subprocess(data_dir):
    def run(argv, env=None):
        name = Path(argv[-1]).name if argv else ""
        if name == "hollie-operator.py":
            _write(Path(data_dir) / "hollie.json", {
                "runId": "run-test",
                "marketingPriorities": [],
                "brief": {"meetings": {"items": []}},
            })
        return types.SimpleNamespace(returncode=0)
    return run


def _book():
    # Northwind closes in the collection month; Contoso closes the next month.
    return {
        "openCount": 2,
        "openAmount": 300000,
        "weighted": 70000,
        "leads": 3,
        "mql": 2,
        "sql": 1,
        "quarterStart": "2026-10-01",
        "quarterEnd": "2026-12-31",
        "largest": {"company": "Northwind", "amount": 200000},
        "deals": [
            {
                "companyName": "Northwind",
                "name": "Northwind renewal",
                "amount": 200000,
                "stage": "Legal & Compliance",
                "stageLabel": "Legal & Compliance",
                "close": "2026-11-30",
                "closed": False,
            },
            {
                "companyName": "Contoso",
                "name": "Contoso expansion",
                "amount": 100000,
                "stage": "Legal & Compliance",
                "stageLabel": "Legal & Compliance",
                "close": "2026-12-31",
                "closed": False,
            },
        ],
    }


class CommitMonthOnRunFacts(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.data = Path(self._tmp.name)
        # 18:00 UTC is 11:00 AM America/Phoenix, so the collection day is 2026-11-16.
        _write(self.data / "records.json", {
            "generatedAt": "2026-11-16T18:00:00Z",
            "verifiedSnapshotId": "brain-2026-11-16",
        })
        _write(self.data / "verified.json", {
            "snapshotId": "brain-2026-11-16",
        })
        _write(self.data / "sheet-review.json", {})
        self.align = _load_align_run(self.data)

    def tearDown(self):
        self._tmp.cleanup()

    def _run(self):
        with mock.patch.object(self.align.subprocess, "run", _fake_subprocess(self.data)), \
             mock.patch.object(self.align, "snapshot_metrics", lambda *a, **k: _book()), \
             mock.patch.object(self.align, "is_junk_name", lambda blob: False):
            # commit_for_close_month also requires the deal to be in the open Sales
            # Pipeline. Keep that check out of this public-repo unit test.
            import gtm_metrics
            with mock.patch.object(gtm_metrics, "is_open_pipeline", lambda *a, **k: True):
                rc = self.align.main()
        self.assertEqual(rc, 0)
        return json.loads((self.data / "run-facts.json").read_text(encoding="utf-8"))

    def test_run_facts_carries_the_collection_month_and_its_definition(self):
        facts = self._run()
        brief = json.loads((self.data / "agent-brief.json").read_text(encoding="utf-8"))
        self.assertEqual(facts["commitMonth"], "2026-11")
        self.assertEqual(brief["facts"]["commitMonth"], "2026-11")
        self.assertEqual(
            facts["commitMonthDefinition"],
            "Commit-stage deals whose close date is in this month and has not passed.")
        # Existing month filter: the December close is not in this month's commit.
        self.assertEqual(facts["commitAmount"], 200000)
        self.assertEqual(facts["commitDeals"], ["Northwind"])

    def test_a_collection_day_in_another_month_changes_commit_month(self):
        _write(self.data / "records.json", {
            "generatedAt": "2026-12-02T18:00:00Z",
            "verifiedSnapshotId": "brain-2026-12-02",
        })
        _write(self.data / "verified.json", {"snapshotId": "brain-2026-12-02"})
        facts = self._run()
        brief = json.loads((self.data / "agent-brief.json").read_text(encoding="utf-8"))
        self.assertEqual(facts["commitMonth"], "2026-12")
        self.assertEqual(brief["facts"]["commitMonth"], "2026-12")
        self.assertEqual(facts["commitDeals"], ["Contoso"])
        self.assertEqual(facts["commitAmount"], 100000)


if __name__ == "__main__":
    unittest.main()
