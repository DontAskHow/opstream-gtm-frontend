"""End-to-end tests for the refresh scripts on synthetic data.

    python3 -m unittest discover -s scripts/tests -v

brain-data.py runs against a synthetic brain.db (tests/fixtures.py); its
output then goes through gtm_metrics.snapshot_metrics with a synthetic Sheet,
the same path the refresh jobs take.
"""
import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
sys.path.insert(0, SCRIPTS)
sys.path.insert(0, HERE)

import fixtures  # noqa: E402
import gtm_metrics as gm  # noqa: E402

TODAY = "2026-10-12"


def run_brain_data(db_path, out_dir):
    """Import brain-data.py fresh (it reads BRAIN_DB / OUT_DATA at import) and run main()."""
    os.environ["BRAIN_DB"] = db_path
    os.environ["OUT_DATA"] = out_dir
    os.environ["GTM_GENERATED_AT"] = TODAY + "T19:00:00+00:00"
    spec = importlib.util.spec_from_file_location("brain_data_under_test", os.path.join(SCRIPTS, "brain-data.py"))
    mod = importlib.util.module_from_spec(spec)
    log = io.StringIO()
    with contextlib.redirect_stdout(log):
        spec.loader.exec_module(mod)
        code = mod.main()
    out = {}
    for name in ("verified", "records"):
        with open(os.path.join(out_dir, name + ".json")) as fh:
            out[name] = json.load(fh)
    return code, out, log.getvalue()


class BrainDataEndToEnd(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, "brain.db")
        self.out = os.path.join(self.tmp.name, "out")

    def tearDown(self):
        self.tmp.cleanup()

    def build(self, **kw):
        fixtures.build_db(self.db, **kw)
        code, out, log = run_brain_data(self.db, self.out)
        self.assertEqual(code, None if code is None else 0, log)
        return out, log

    def test_closed_comes_from_stage_metadata(self):
        out, _ = self.build()
        opps = {o["id"]: o for o in out["verified"]["opportunities"]}
        # Closed lost and Disqualified have non-default stage ids: only isClosed can close them.
        self.assertEqual({i for i, o in opps.items() if o["hubspotClosed"]}, {"deal-103", "deal-109"})
        self.assertEqual(opps["deal-104"]["hubspotStageLabel"], "On Hold")
        records_deals = {d["id"]: d for c in out["records"]["companies"] for d in c["deals"]}
        self.assertTrue(records_deals["deal-103"]["hubspotClosed"])
        self.assertFalse(records_deals["deal-104"]["hubspotClosed"])
        self.assertEqual(records_deals["deal-101"]["pipeline"], "default")

    def test_hs_is_closed_is_the_fallback_without_metadata(self):
        out, _ = self.build(with_metadata=False)
        opps = {o["id"]: o for o in out["verified"]["opportunities"]}
        self.assertEqual({i for i, o in opps.items() if o["hubspotClosed"]}, {"deal-103", "deal-109"})

    def test_probability_is_hubspot_fraction(self):
        out, _ = self.build()
        opps = {o["id"]: o for o in out["verified"]["opportunities"]}
        self.assertAlmostEqual(opps["deal-101"]["probability"], 0.05)
        self.assertIsNone(opps["deal-105"]["probability"])
        records_deals = {d["id"]: d for c in out["records"]["companies"] for d in c["deals"]}
        self.assertEqual(records_deals["deal-102"]["probability"], 25.0)  # records.json keeps percent

    def test_snapshot_metrics_on_brain_data_output(self):
        out, _ = self.build()
        m = gm.snapshot_metrics(out["verified"], out["records"], today=TODAY, sheet_review=fixtures.sheet_review())
        in_book = {d["id"] for d in m["openDeals"]}
        # 103 is Sheet-active but closed lost in HubSpot -> out. 105 is HubSpot-only -> in.
        self.assertEqual(in_book, {"deal-101", "deal-102", "deal-105"})
        self.assertEqual(m["openCount"], 3)
        self.assertEqual(m["openAmount"], 190000)
        self.assertEqual(m["weighted"], 17500)  # 100000*.05 + 50000*.25; 105 has no probability
        self.assertEqual(m["hubspotOnlyCount"], 1)
        self.assertEqual((m["onHoldCount"], m["onHoldAmount"]), (1, 30000))
        self.assertEqual((m["renewalCount"], m["renewalAmount"]), (1, 20000))
        reasons = {d["id"]: d["reason"] for d in m["deals"]}
        self.assertEqual(reasons["deal-103"], "closed")
        self.assertEqual(reasons["deal-109"], "Disqualified")
        self.assertEqual(reasons["deal-106"], "renewal")
        self.assertEqual(reasons["deal-108"], "not in the Sales Pipeline")
        self.assertEqual(reasons["deal-104"], "On Hold")
        self.assertEqual(m["definition"], gm.PIPELINE_DEF["definition"])


class OpenBookRules(unittest.TestCase):
    def test_sheet_active_but_hubspot_closed_is_out(self):
        deal = {"id": "deal-1", "onSheet": True, "sheetClass": "active", "stage": "SQL",
                "pipeline": "default", "pipelineLabel": "Sales Pipeline", "closed": True}
        self.assertFalse(gm.is_open_pipeline(deal, TODAY))

    def test_closed_only_from_isclosed_flag_never_stage_name(self):
        deal = {"id": "deal-1", "stage": "Closed lost", "pipeline": "default", "pipelineLabel": "Sales Pipeline", "closed": False}
        self.assertEqual(gm.pipeline_status(deal), "open")
        self.assertTrue(gm.is_open_pipeline(dict(deal, hubspotStage="Disqualified"), TODAY))

    def test_sheet_does_not_decide_membership(self):
        opp = {"id": "deal-9", "stage": "SQL", "stageLabel": "SQL", "pipeline": "default",
               "pipelineLabel": "Sales Pipeline", "closed": False}
        held_on_sheet = gm.apply_sheet_deal(opp, {"9": {"stage": "On Hold"}})
        self.assertEqual(held_on_sheet["hubspotStageLabel"], "SQL")
        self.assertTrue(gm.is_open_pipeline(held_on_sheet, TODAY))
        held_in_hubspot = gm.apply_sheet_deal(dict(opp, stage="On Hold", stageLabel="On Hold"), {"9": {"stage": "SQL"}})
        self.assertFalse(gm.is_open_pipeline(held_in_hubspot, TODAY))
        self.assertTrue(gm.is_on_hold(held_in_hubspot))

    def test_no_recorded_pipeline_is_not_new_business(self):
        deal = {"id": "deal-8", "onSheet": True, "sheetClass": "active", "stage": "SQL", "closed": False}
        self.assertFalse(gm.is_open_pipeline(deal, TODAY))
        self.assertEqual(gm.exclusion_reason(deal, TODAY), "pipeline not recorded")

    def test_hubspot_only_open_deal_is_in(self):
        deal = {"id": "deal-2", "stage": "SQL", "pipeline": "default", "pipelineLabel": "Sales Pipeline", "closed": False,
                "close": "2026-01-01"}  # past close stays in, flagged
        self.assertTrue(gm.is_open_pipeline(deal, TODAY))
        self.assertTrue(gm.is_hubspot_only_open(deal, TODAY))
        self.assertTrue(gm.close_date_passed(deal, TODAY))

    def test_other_pipelines_never_in_new_business(self):
        for label in ("Renewal Pipeline", "Customer Success Pipeline", "Partnerships Pipeline"):
            deal = {"id": "deal-3", "onSheet": True, "sheetClass": "active", "stage": "SQL", "pipelineLabel": label}
            self.assertFalse(gm.is_open_pipeline(deal, TODAY), label)
        # The Sales Pipeline is decided by its id, as in workspace-data.py, not by a label.
        sheet_active = {"id": "deal-3", "onSheet": True, "sheetClass": "active", "stage": "SQL",
                        "pipeline": "p-other", "pipelineLabel": "Sales Pipeline"}
        self.assertFalse(gm.is_open_pipeline(sheet_active, TODAY))

    def test_on_hold_is_separate(self):
        deal = {"id": "deal-4", "stage": "On Hold", "pipeline": "default", "pipelineLabel": "Sales Pipeline", "closed": False}
        self.assertFalse(gm.is_open_pipeline(deal, TODAY))
        self.assertEqual(gm.on_hold_book([deal])["count"], 1)
        self.assertEqual(gm.on_hold_book([dict(deal, closed=True)])["count"], 0)

    def test_sheet_only_row_is_not_in_the_book(self):
        review = {"deals": [{"id": "77", "name": "Example - New Deal", "company": "Example", "stage": "SQL",
                             "amount": 1000.0, "probability": 5.0}]}
        rows = gm.deals_with_sheet([], review)  # not in HubSpot at all: no pipeline, not in the book
        self.assertFalse(gm.is_open_pipeline(rows[0], TODAY))


class WeightedConsistency(unittest.TestCase):
    def test_no_probability_counted_separately(self):
        deals = [
            {"id": "a", "pipeline": "default", "amount": 1000, "probability": 0.5},
            {"id": "b", "pipeline": "default", "amount": 3000, "probability": None},
            {"id": "c", "pipeline": "default", "amount": None, "probability": 0.5},
        ]
        t = gm.pipeline_totals(deals, TODAY)
        self.assertEqual((t["count"], t["openAmount"], t["weighted"]), (3, 4000, 500))
        o = gm.open_totals(t["deals"])
        self.assertEqual((o["count"], o["openAmount"], o["weighted"]), (3, 4000, 500))
        self.assertEqual((o["noProbabilityCount"], o["noProbabilityAmount"], o["noAmountCount"]), (1, 3000, 1))
        self.assertLessEqual(o["weighted"], o["openAmount"] - o["noProbabilityAmount"])

    def test_empty_book(self):
        t = gm.pipeline_totals([], TODAY)
        self.assertEqual((t["count"], t["weighted"]), (0, None))
        self.assertEqual(gm.open_totals([])["noProbabilityCount"], 0)


if __name__ == "__main__":
    unittest.main()
