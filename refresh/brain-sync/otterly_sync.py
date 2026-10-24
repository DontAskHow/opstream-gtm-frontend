#!/usr/bin/env python3
"""Otterly publisher quota gate (public-safe constant + skip logic).

Quota rule: check API usage first. Over 75% of the period's requests used, or
usage unknown, skips the refresh (recorded, not an error).

The live fetcher reads a token from a secrets store (placeholder name
``example/otterly-token``) and calls the public Otterly host data.otterly.ai.
Deploy wiring and real secret names stay on the private tip / image source;
this module only publishes the stop threshold and the pure skip gate for
provenance on public main.
"""

from __future__ import annotations

QUOTA_THRESHOLD = 0.75
HOST = "data.otterly.ai"


class SourceSkipped(Exception):
    """Refresh skipped (quota or unknown usage); not an error."""


def should_skip_for_quota(used, limit, threshold: float = QUOTA_THRESHOLD) -> str | None:
    """Return a skip reason if the run must not spend more quota, else None.

    Pure gate: no network, no secrets. Callers that already fetched
    accounts/info pass used/limit here before any further Otterly calls.
    """
    if not isinstance(used, (int, float)) or not isinstance(limit, (int, float)) or limit <= 0:
        return "API request usage is not reported by /v1/accounts/info; not spending quota"
    if used / limit > threshold:
        return (
            "API requests %d/%d used (%.0f%%), over the %.0f%% limit"
            % (used, limit, used / limit * 100, threshold * 100)
        )
    return None


def enforce_quota(used, limit, threshold: float = QUOTA_THRESHOLD) -> None:
    """Raise SourceSkipped when usage is unknown or over QUOTA_THRESHOLD."""
    reason = should_skip_for_quota(used, limit, threshold)
    if reason:
        raise SourceSkipped(reason)
