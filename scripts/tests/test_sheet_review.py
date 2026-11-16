"""sheet-review.py stage mismatches: a probability difference inside one forecast
bucket is a mismatch, not only a bucket change. Synthetic names, ids and figures.

    python3 -m unittest scripts/tests/test_sheet_review.py
"""
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    "sheet_review", os.path.join(HERE, "..", "sheet-review.py"))
sr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sr)

# Default Forecast buckets: Pipeline = SQL + Discovery + Demo; Commit = Decision + Legal.
BUCKETS = sr.parse_forecast([])

STAGE_LABEL = {
    "stage-discovery": "Discovery/RFP received (Deal)",
    "stage-demo": "Demo meeting",
    "stage-sql": "SQL",
    "stage-legal": "Legal & Compliance",
}


def sheet(stage, prob, name="Northwind renewal", company="Northwind"):
    return {"name": name, "company": company, "stage": stage, "probability": prob}


def hubspot(stage_id, prob, name="Northwind renewal"):
    return {"name": name, "stage": stage_id, "probability": prob}


class WithinBucketProbability(unittest.TestCase):
    def test_same_bucket_different_probabilities_is_a_stage_mismatch(self):
        # Both stages sit in Pipeline; 10% vs 25% used to produce no row.
        row = sr.stage_mismatch_row(
            sheet("Discovery/RFP received (Deal)", 10),
            hubspot("stage-demo", 0.25),
            BUCKETS, STAGE_LABEL, "1001")
        self.assertIsNotNone(row)
        self.assertEqual(row["field"], "stage")
        self.assertEqual(row["dealId"], "1001")
        self.assertEqual(row["sheet"], "Discovery/RFP received (Deal)")
        self.assertEqual(row["hubspot"], "Demo meeting")
        self.assertEqual(row["sheetBucket"], "pipeline")
        self.assertEqual(row["hubspotBucket"], "pipeline")
        self.assertEqual((row["sheetProbability"], row["hubspotProbability"]), (10, 25))

    def test_same_bucket_same_probability_is_not_a_mismatch(self):
        row = sr.stage_mismatch_row(
            sheet("Discovery/RFP received (Deal)", 10),
            hubspot("stage-demo", 0.10),
            BUCKETS, STAGE_LABEL, "1002")
        self.assertIsNone(row)

    def test_percent_and_fraction_of_the_same_value_are_equal(self):
        self.assertFalse(sr.probs_differ(10, 0.10))
        self.assertFalse(sr.probs_differ(25, 25))
        self.assertTrue(sr.probs_differ(10, 0.25))

    def test_cross_bucket_stage_still_mismatches(self):
        row = sr.stage_mismatch_row(
            sheet("SQL", 5),
            hubspot("stage-legal", 0.80),
            BUCKETS, STAGE_LABEL, "1003")
        self.assertIsNotNone(row)
        self.assertEqual((row["sheetBucket"], row["hubspotBucket"]), ("pipeline", "commit"))
        self.assertEqual((row["sheetProbability"], row["hubspotProbability"]), (5, 80))

    def test_matching_stage_and_probability_is_clean(self):
        row = sr.stage_mismatch_row(
            sheet("Demo meeting", 25),
            hubspot("stage-demo", 0.25),
            BUCKETS, STAGE_LABEL, "1004")
        self.assertIsNone(row)

    def test_missing_probabilities_in_the_same_bucket_are_not_a_mismatch(self):
        row = sr.stage_mismatch_row(
            sheet("Discovery/RFP received (Deal)", None),
            hubspot("stage-demo", None),
            BUCKETS, STAGE_LABEL, "1005")
        self.assertIsNone(row)


if __name__ == "__main__":
    unittest.main()
