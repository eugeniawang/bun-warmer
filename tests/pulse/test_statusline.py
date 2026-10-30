"""Tests for bin/statusline.py. Run with: python3 -m unittest discover -s tests/pulse"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "..", "bin", "statusline.py")
spec = importlib.util.spec_from_file_location("statusline", SCRIPT)
sl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sl)

NOW = 1_800_000_000


def state(**over):
    s = {"armed": True, "expiresAtEpoch": NOW + 130 * 60, "statusState": "warm", "lastActivityAtEpoch": NOW - 13 * 60,
         "nextPingAtEpoch": NOW + 37 * 60, "lastPing": None, "stalledAgents": [], "statusText": "x"}
    s.update(over)
    return s


class Segment(unittest.TestCase):
    def test_warm_with_live_countdowns(self):
        self.assertEqual(sl.segment(state(), NOW), "bun-warmer · warm · 2h10m left · ping in 37m")

    def test_a_not_pinging_reason_from_the_mod_replaces_the_countdown(self):
        s = state(statusText="bun-warmer · warm · 2h30m left · context size unknown, not pinging")
        self.assertEqual(sl.segment(s, NOW), "bun-warmer · warm · 2h10m left · context size unknown, not pinging")

    def test_cold_after_an_hour_without_activity_or_good_ping(self):
        self.assertEqual(sl.segment(state(lastActivityAtEpoch=NOW - 61 * 60), NOW), "bun-warmer · cold · 2h10m left")

    def test_idle_and_cold_keep_the_mods_reason_when_it_saw_the_same_state(self):
        s = state(lastActivityAtEpoch=0, statusState="idle", statusText="bun-warmer · idle · 3h00m left · waiting for the first turn")
        self.assertEqual(sl.segment(s, NOW), "bun-warmer · idle · 2h10m left · waiting for the first turn")
        s = state(lastActivityAtEpoch=NOW - 61 * 60, statusText="bun-warmer · cold · 1h00m left · cache cold, waiting for activity")
        self.assertEqual(sl.segment(s, NOW), "bun-warmer · cold · 2h10m left · cache cold, waiting for activity")

    def test_a_reason_written_for_another_state_is_not_shown(self):
        s = state(lastActivityAtEpoch=NOW - 61 * 60, statusText="bun-warmer · warm · 1h00m left · ping in 5m")
        self.assertEqual(sl.segment(s, NOW), "bun-warmer · cold · 2h10m left")

    def test_a_good_ping_keeps_it_warm(self):
        s = state(lastActivityAtEpoch=NOW - 90 * 60, lastPing={"ok": True, "atEpoch": NOW - 40 * 60})
        self.assertTrue(sl.segment(s, NOW).startswith("bun-warmer · warm"))

    def test_failed_ping_and_stall_are_shown(self):
        s = state(lastPing={"ok": False, "atEpoch": NOW - 5}, stalledAgents=[{"id": "a"}])
        self.assertIn("last ping FAILED", sl.segment(s, NOW))
        self.assertIn("STALLED: 1 subagent", sl.segment(s, NOW))

    def test_not_pinging_shows_the_mods_reason(self):
        s = state(statusState="off", statusText="bun-warmer off: main cache lasts 5 minutes (API key login), so a ping cannot keep it warm; not pinging")
        self.assertEqual(sl.segment(s, NOW), s["statusText"])

    def test_nothing_when_off_or_expired(self):
        self.assertEqual(sl.segment(state(armed=False), NOW), "")
        self.assertEqual(sl.segment(state(expiresAtEpoch=NOW - 1), NOW), "")
        self.assertEqual(sl.segment(None, NOW), "")

    def test_safe_name_matches_the_mod(self):
        self.assertEqual(sl.safe_name("89e8e7d6-ca67-44fd-bb20-87b456e44dca"), "89e8e7d6-ca67-44fd-bb20-87b456e44dca")
        self.assertEqual(sl.safe_name("a/b"), "a%2Fb")
        self.assertEqual(sl.safe_name("a.b%"), "a%2Eb%25")
        self.assertEqual(sl.safe_name("x\ud800"), "x%EF%BF%BD")


class Main(unittest.TestCase):
    def run_script(self, home, stdin):
        env = dict(os.environ, HOME=home)
        return subprocess.run([sys.executable, SCRIPT], input=stdin, capture_output=True, text=True, env=env, timeout=10)

    def test_reads_the_session_file_from_stdin_session_id(self):
        with tempfile.TemporaryDirectory() as home:
            d = os.path.join(home, ".claude", "bun-warmer")
            os.makedirs(d)
            import time
            now = int(time.time())
            with open(os.path.join(d, "S1.json"), "w") as f:
                json.dump({"armed": True, "expiresAtEpoch": now + 3600, "statusState": "warm", "lastActivityAtEpoch": now, "nextPingAtEpoch": now + 50 * 60}, f)
            r = self.run_script(home, json.dumps({"session_id": "S1"}))
            self.assertEqual(r.returncode, 0)
            self.assertTrue(r.stdout.startswith("bun-warmer · warm · "), r.stdout)

    def test_silent_on_missing_file_or_bad_input(self):
        with tempfile.TemporaryDirectory() as home:
            for stdin in ["", "not json", json.dumps({"session_id": "nope"}), json.dumps([1])]:
                r = self.run_script(home, stdin)
                self.assertEqual((r.returncode, r.stdout), (0, ""), stdin)


if __name__ == "__main__":
    unittest.main()
