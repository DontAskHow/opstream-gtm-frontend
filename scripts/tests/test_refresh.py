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

    def test_closed_stages_come_from_stage_metadata(self):
        out, log = self.build()
        opp_ids = {o["id"] for o in out["verified"]["opportunities"]}
        # Custom closed stages (Closed lost, Disqualified with non-default ids) are closed.
        self.assertEqual(opp_ids, {"deal-101", "deal-102", "deal-104", "deal-105", "deal-106", "deal-107", "deal-108"})
        closed = {d["id"]: d["stage"] for d in out["verified"]["closedDeals"]}
        self.assertEqual(set(closed), {"deal-103", "deal-109"})
        self.assertIn("stage metadata", log)
        records_deals = {d["id"]: d for c in out["records"]["companies"] for d in c["deals"]}
        self.assertTrue(records_deals["deal-103"]["closed"])
        self.assertFalse(records_deals["deal-104"]["closed"])

    def test_hs_is_closed_is_the_fallback_without_metadata(self):
        out, log = self.build(with_metadata=False)
        self.assertEqual({d["id"] for d in out["verified"]["closedDeals"]}, {"deal-103", "deal-109"})
        self.assertIn("'hs_is_closed': 9", log)

    def test_probability_is_hubspot_fraction(self):
        out, _ = self.build()
        self.assertEqual(out["verified"]["probabilityScale"], "fraction")
        opps = {o["id"]: o for o in out["verified"]["opportunities"]}
        self.assertAlmostEqual(opps["deal-101"]["probability"], 0.05)
        self.assertIsNone(opps["deal-105"]["probability"])
        records_deals = {d["id"]: d for c in out["records"]["companies"] for d in c["deals"]}
        self.assertEqual(records_deals["deal-102"]["probability"], 25.0)  # records.json keeps percent

    def test_report_stage_table_is_per_pipeline(self):
        out, _ = self.build()
        report = out["verified"]["report"]["pipeline"]
        by = {p["pipeline"]: p for p in report["byPipeline"]}
        self.assertEqual(set(by), {"Sales Pipeline", "Renewal Pipeline", "Customer Success Pipeline", "Partnerships Pipeline"})
        # "Negotiations" exists in two pipelines and is never merged.
        self.assertEqual([s["stage"] for s in by["Renewal Pipeline"]["stages"]], ["Negotiations"])
        self.assertEqual([s["stage"] for s in by["Customer Success Pipeline"]["stages"]], ["Negotiations"])
        self.assertEqual(by["Renewal Pipeline"]["stages"][0]["amount"], 20000)
        self.assertEqual(by["Customer Success Pipeline"]["stages"][0]["amount"], 15000)
        for row in report["stages"]:
            self.assertEqual(row["pipeline"], "Sales Pipeline")
        sales = by["Sales Pipeline"]
        self.assertEqual(sales["kind"], "new business")
        # 104 is On Hold: its own line, not in the open totals (pipeline-def.json).
        self.assertEqual(sales["count"], 3)
        self.assertEqual(sales["openAmount"], 190000)
        self.assertEqual(sales["weighted"], 17500)  # 100000*.05 + 50000*.25
        self.assertEqual(sales["noProbabilityCount"], 1)
        self.assertEqual(sales["onHold"], {"count": 1, "amount": 30000})
        self.assertEqual(report["open"]["value"], 190000)  # new business only
        self.assertEqual(report["onHold"], {"count": 1, "amount": 30000})
        self.assertEqual(by["Partnerships Pipeline"]["noAmountCount"], 1)

    def test_snapshot_metrics_on_brain_data_output(self):
        out, _ = self.build()
        m = gm.snapshot_metrics(out["verified"], out["records"], today=TODAY, sheet_review=fixtures.sheet_review())
        in_book = {d["id"] for d in m["openDeals"]}
        # 103 is Sheet-active but closed lost in HubSpot -> out. 105 is HubSpot-only -> in.
        self.assertEqual(in_book, {"deal-101", "deal-102", "deal-105"})
        self.assertEqual(m["openCount"], 3)
        self.assertEqual(m["openAmount"], 190000)
        self.assertEqual(m["weighted"], 17500)
        self.assertEqual(m["noProbabilityCount"], 1)
        self.assertEqual(m["noProbabilityAmount"], 40000)
        self.assertEqual(m["closedInHubspotSheetActive"], 1)
        self.assertEqual(m["hubspotOnlyCount"], 1)
        self.assertEqual((m["onHoldCount"], m["onHoldAmount"]), (1, 30000))
        reasons = {d["id"]: d["reason"] for d in m["deals"]}
        self.assertEqual(reasons["deal-103"], "closed in HubSpot, still active on the Sheet")
        self.assertEqual(reasons["deal-106"], "renewal")
        self.assertEqual(reasons["deal-108"], "partnership")
        self.assertEqual(reasons["deal-104"], "On Hold")
        # The report and the run metrics are one definition.
        report = out["verified"]["report"]["pipeline"]
        self.assertEqual((m["openCount"], m["openAmount"], m["onHoldCount"]),
                         (report["scorecard"][0]["value"], report["open"]["value"], report["onHold"]["count"]))
        self.assertEqual(m["definition"], gm.PIPELINE_DEF["definition"])
        self.assertTrue({s["pipeline"] for s in m["stages"]} <= {"Sales Pipeline", "Pipeline not recorded"})


class OpenBookRules(unittest.TestCase):
    def test_sheet_active_but_hubspot_closed_is_out(self):
        deal = {"id": "deal-1", "onSheet": True, "sheetClass": "active", "stage": "SQL",
                "pipelineLabel": "Sales Pipeline", "closed": True}
        self.assertFalse(gm.is_open_pipeline(deal, TODAY))

    def test_closed_only_from_isclosed_flag_never_stage_name(self):
        deal = {"id": "deal-1", "stage": "Closed lost", "pipelineLabel": "Sales Pipeline", "closed": False}
        self.assertEqual(gm.pipeline_status(deal), "open")
        self.assertTrue(gm.is_open_pipeline(dict(deal, hubspotStage="Disqualified"), TODAY))

    def test_sheet_does_not_decide_membership(self):
        opp = {"id": "deal-9", "stage": "SQL", "stageLabel": "SQL", "pipeline": "p1",
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
        deal = {"id": "deal-2", "stage": "SQL", "pipelineLabel": "Sales Pipeline", "closed": False,
                "close": "2026-01-01"}  # past close stays in, flagged
        self.assertTrue(gm.is_open_pipeline(deal, TODAY))
        self.assertTrue(gm.is_hubspot_only_open(deal, TODAY))
        self.assertTrue(gm.close_date_passed(deal, TODAY))

    def test_other_pipelines_never_in_new_business(self):
        for label in ("Renewal Pipeline", "Customer Success Pipeline", "Partnerships Pipeline"):
            deal = {"id": "deal-3", "onSheet": True, "sheetClass": "active", "stage": "SQL", "pipelineLabel": label}
            self.assertFalse(gm.is_open_pipeline(deal, TODAY), label)

    def test_on_hold_is_separate(self):
        deal = {"id": "deal-4", "stage": "On Hold", "pipelineLabel": "Sales Pipeline", "closed": False}
        self.assertFalse(gm.is_open_pipeline(deal, TODAY))
        self.assertEqual(gm.on_hold_book([deal])["count"], 1)
        self.assertEqual(gm.on_hold_book([dict(deal, closed=True)])["count"], 0)

    def test_sheet_only_row_closed_in_hubspot(self):
        review = {"deals": [{"id": "77", "name": "Example - New Deal", "company": "Example", "stage": "SQL",
                             "amount": 1000.0, "probability": 5.0}]}
        rows = gm.deals_with_sheet([], review, {"77": "Closed lost"})
        self.assertTrue(rows[0]["hubspotClosed"])
        self.assertFalse(gm.is_open_pipeline(rows[0], TODAY))
        rows = gm.deals_with_sheet([], review)  # not in HubSpot at all: no pipeline, not in the book
        self.assertFalse(gm.is_open_pipeline(rows[0], TODAY))
        self.assertAlmostEqual(rows[0]["probability"], 0.05)


class WeightedConsistency(unittest.TestCase):
    def test_no_probability_counted_separately(self):
        deals = [
            {"id": "a", "pipelineLabel": "Sales Pipeline", "amount": 1000, "probability": 0.5},
            {"id": "b", "pipelineLabel": "Sales Pipeline", "amount": 3000, "probability": None},
            {"id": "c", "pipelineLabel": "Sales Pipeline", "amount": None, "probability": 0.5},
        ]
        t = gm.pipeline_totals(deals, TODAY)
        self.assertEqual(t["count"], 3)
        self.assertEqual(t["openAmount"], 4000)
        self.assertEqual(t["weighted"], 500)
        self.assertEqual(t["noProbabilityCount"], 1)
        self.assertEqual(t["noProbabilityAmount"], 3000)
        self.assertEqual(t["noAmountCount"], 1)
        self.assertLessEqual(t["weighted"], t["openAmount"] - t["noProbabilityAmount"])

    def test_empty_book(self):
        t = gm.pipeline_totals([], TODAY)
        self.assertEqual((t["count"], t["weighted"], t["noProbabilityCount"]), (0, None, 0))


class StageTable(unittest.TestCase):
    def test_same_stage_label_in_two_pipelines(self):
        rows = gm.stage_table([
            {"pipelineLabel": "Renewal Pipeline", "stage": "Negotiations", "amount": 10},
            {"pipelineLabel": "Customer Success Pipeline", "stage": "Negotiations", "amount": 5},
            {"pipelineLabel": "Customer Success Pipeline", "stage": "Negotiations", "amount": 5},
        ])
        self.assertEqual([(r["pipeline"], r["count"], r["amount"]) for r in rows],
                         [("Customer Success Pipeline", 2, 10), ("Renewal Pipeline", 1, 10)])


class ProbabilityScale(unittest.TestCase):
    def test_fraction_is_kept_even_when_small(self):
        # The old heuristic multiplied by 100 when every value was <= 0.02.
        opps = [{"id": "a", "probability": 0.01}, {"id": "b", "probability": 0.02}]
        out = gm.annotate_opportunities(opps, {})
        self.assertEqual([o["probability"] for o in out], [0.01, 0.02])

    def test_percent_scale_is_explicit(self):
        out = gm.annotate_opportunities([{"id": "a", "probability": 40}], {}, scale="percent")
        self.assertAlmostEqual(out[0]["probability"], 0.4)

    def test_out_of_scale_is_unknown_not_guessed(self):
        out = gm.annotate_opportunities([{"id": "a", "probability": 40}], {})
        self.assertIsNone(out[0]["probability"])
        self.assertIsNone(gm.probability_from_scale(-0.1, "fraction"))
        self.assertIsNone(gm.probability_from_scale(101, "percent"))
        self.assertEqual(gm.probability_from_scale(1, "fraction"), 1.0)
        self.assertEqual(gm.probability_from_scale(1, "percent"), 0.01)
        with self.assertRaises(ValueError):
            gm.probability_from_scale(0.5, "auto")


if __name__ == "__main__":
    unittest.main()
