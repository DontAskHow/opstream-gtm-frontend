#!/usr/bin/env python3
"""Synthetic-safe account alias helpers for GTM metrics.

Only the Kidde/Carrier display-name alias is published here for provenance.
Full metrics / customer lists stay on the private tip / image source.
"""

from __future__ import annotations

import re


def account_name(company_name_value, deal_name=None):
    """Return a display account name; apply the Kidde/Carrier alias when both match.

    Synthetic example: company "Carrier Fire Demo", deal "Kidde renewal demo"
    → "Kidde Global Solutions". No real customer roster is included.
    """
    name = (company_name_value or "").strip() or None
    deal = (deal_name or "").strip() or None
    if re.search(r"\bkidde\b", deal or "", flags=re.I) and re.search(
        r"\bcarrier\b", name or "", flags=re.I
    ):
        return "Kidde Global Solutions"
    return name or None
