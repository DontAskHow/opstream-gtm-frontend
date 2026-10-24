# Otterly publisher quota gate

Public-safe note only. The Otterly publisher skips a refresh when more than 75% of the period's API requests are already used (or when usage is unknown).

See `otterly_sync.py` (`QUOTA_THRESHOLD = 0.75`). Live deploy wiring, secret names, and the full sync suite stay on the private tip / image source — not on public main.
