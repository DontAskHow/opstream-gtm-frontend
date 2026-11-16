"""The sync-only lock (locks/sync-only.json) against a filesystem store (FsStore).

A run keeps the lock for as long as it heartbeats, a dead run's lock is taken
over, and a run only deletes a lock it still owns. main_sync_only runs with
_sync_only replaced, so nothing syncs or builds. No network, no AWS.
"""
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import run  # noqa: E402

ENV = {"SYNC_SKIP_WINDOWS": "", "SYNC_LOCK_TTL_MIN": "50"}


def ago(minutes):
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat()


class SyncLock(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="sync-lock-"))
        self.store = run.FsStore(self.tmp / "store")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def put_lock(self, **body):
        self.store.put_bytes(run.LOCK_KEY, json.dumps(body).encode(), "application/json")

    def held(self):
        return json.loads(self.store.get_bytes(run.LOCK_KEY))

    def wait_for(self, cond, timeout=5.0):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if cond():
                return True
            time.sleep(0.01)
        return False

    def sync_run(self, body=None, **env):
        """main_sync_only once, with body() standing in for _sync_only. Returns (exit code, log, ran)."""
        ran = []

        def fake_sync_only(*_):
            ran.append(True)
            return body() if body else 0

        buf = io.StringIO()
        with mock.patch.dict(os.environ, dict(ENV, **env)), \
                mock.patch.object(run, "_sync_only", fake_sync_only), \
                mock.patch.object(run, "LOCK_HEARTBEAT_S", 0.02, create=True), \
                contextlib.redirect_stdout(buf):
            code = run.main_sync_only({}, self.store)
        return code, buf.getvalue(), bool(ran)

    def test_run_past_ttl_keeps_lock_by_heartbeat(self):
        """A run 70 minutes in (past the 50-minute TTL) renews its lock; the scheduled run skips."""
        seen = {}

        def long_run():
            lock = self.held()
            # The run started 70 minutes ago and its last heartbeat was 60 minutes ago.
            lock.update(startedAt=ago(70), heartbeatAt=ago(60))
            self.put_lock(**lock)
            self.assertTrue(self.wait_for(lambda: self.held().get("heartbeatAt", "") > ago(1)),
                            "the running run did not renew its lock")
            before = self.store.get_bytes(run.LOCK_KEY)
            with mock.patch.dict(os.environ, ENV), contextlib.redirect_stdout(io.StringIO()):
                seen["second"] = run.acquire_lock(self.store, 50)
            seen["after"] = self.held()
            seen["same_owner"] = json.loads(before).get("token") == seen["after"].get("token")
            return 0

        code, log, ran = self.sync_run(long_run)
        self.assertTrue(ran, log)
        self.assertFalse(seen["second"], "a second run took over a live run's lock\n" + log)
        self.assertTrue(seen["same_owner"], "the live run's lock was overwritten")
        self.assertFalse(self.store.exists(run.LOCK_KEY), "the run did not release its own lock\n" + log)

    def test_scheduled_run_skips_live_lock_past_ttl(self):
        """A lock started 70 minutes ago with a heartbeat 1 minute ago: the scheduled run exits, lock untouched."""
        self.put_lock(token="live-run", startedAt=ago(70), heartbeatAt=ago(1), task="a")
        before = self.store.get_bytes(run.LOCK_KEY)
        code, log, ran = self.sync_run()
        self.assertEqual(code, 0, log)
        self.assertFalse(ran, "the scheduled run took over a live run\n" + log)
        self.assertEqual(self.store.get_bytes(run.LOCK_KEY), before, "the live run's lock was changed")

    def test_dead_run_lock_is_reclaimed(self):
        """No heartbeat for 55 minutes (TTL 50): the next run takes the lock, runs, and releases it."""
        self.put_lock(token="dead-run", startedAt=ago(90), heartbeatAt=ago(55), task="a")
        owner = {}
        code, log, ran = self.sync_run(lambda: owner.setdefault("token", self.held().get("token")) and 0)
        self.assertTrue(ran, "a dead run's lock was not reclaimed\n" + log)
        self.assertNotEqual(owner["token"], "dead-run")
        self.assertFalse(self.store.exists(run.LOCK_KEY), log)

    def test_pre_heartbeat_lock_is_judged_on_started_at(self):
        """A lock written before heartbeats (startedAt only) is still reclaimed past the TTL and kept inside it."""
        self.put_lock(startedAt=ago(10), task="old")
        with mock.patch.dict(os.environ, ENV), contextlib.redirect_stdout(io.StringIO()):
            self.assertFalse(run.acquire_lock(self.store, 50))
        self.put_lock(startedAt=ago(51), task="old")
        with mock.patch.dict(os.environ, ENV), contextlib.redirect_stdout(io.StringIO()):
            self.assertTrue(run.acquire_lock(self.store, 50))

    def test_one_of_two_runs_reclaims_a_dead_lock(self):
        """Two runs both read the same dead lock; only one of them may end up holding it."""
        self.put_lock(token="dead-run", startedAt=ago(90), heartbeatAt=ago(55), task="a")
        store, results = self.store, {}
        real_get, real_get_tag = run.FsStore.get_bytes, run.FsStore.get_with_tag
        state = {"armed": True}

        def interleave(read):
            # Run B reads the dead lock, then run A acquires before B acts on what it read.
            def wrapped(key):
                value = read(store, key)
                if key == run.LOCK_KEY and state["armed"]:
                    state["armed"] = False
                    results["a"] = run.acquire_lock(store, 50)
                return value
            return wrapped

        with mock.patch.dict(os.environ, ENV), contextlib.redirect_stdout(io.StringIO()), \
                mock.patch.object(store, "exists", lambda key: store._path(key).is_file()), \
                mock.patch.object(store, "get_bytes", interleave(real_get)), \
                mock.patch.object(store, "get_with_tag", interleave(real_get_tag)):
            results["b"] = run.acquire_lock(store, 50)
        self.assertTrue(results["a"])
        self.assertFalse(results["b"], "both runs took the dead lock")

    def test_run_that_lost_its_lock_leaves_the_new_owner_alone(self):
        """Run A's lock is taken over mid-run by B: A neither renews nor deletes B's lock on exit."""
        b_lock = {"token": "run-b", "startedAt": ago(2), "heartbeatAt": ago(2), "task": "b"}

        def taken_over():
            self.put_lock(**b_lock)
            time.sleep(0.2)  # about ten of A's heartbeat intervals
            return 0

        code, log, ran = self.sync_run(taken_over)
        self.assertTrue(ran, log)
        self.assertTrue(self.store.exists(run.LOCK_KEY), "the old run deleted the new owner's lock\n" + log)
        self.assertEqual(self.held(), b_lock, "the old run rewrote the new owner's lock")

    def test_heartbeat_stops_after_max_hold(self):
        """A run that has held the lock past SYNC_LOCK_MAX_MIN stops renewing, so a hung run still goes stale."""
        seen = {}

        def hung():
            lock = self.held()
            lock.update(startedAt=ago(241), heartbeatAt=ago(30))
            self.put_lock(**lock)
            time.sleep(0.2)
            seen["heartbeatAt"] = self.held()["heartbeatAt"]
            seen["was"] = lock["heartbeatAt"]
            return 0

        code, log, ran = self.sync_run(hung, SYNC_LOCK_MAX_MIN="240")
        self.assertEqual(seen["heartbeatAt"], seen["was"], "the lock was renewed past the max hold\n" + log)


if __name__ == "__main__":
    unittest.main()
