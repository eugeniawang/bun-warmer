import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCRIPT = os.path.join(ROOT, "bin", "session-pulse.py")
SID = "11111111-2222-3333-4444-555555555555"
NOW = 2_000_000_000.0


def iso(epoch):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(epoch)) + ".000Z"


def tool_use(i, name="Bash", inp=None, ts=None):
    return {"type": "assistant", "timestamp": iso(ts or NOW - 10),
            "message": {"content": [{"type": "tool_use", "id": i, "name": name, "input": inp or {"command": i}}]}}


def tool_result(i):
    return {"type": "user", "timestamp": iso(NOW - 5),
            "message": {"content": [{"type": "tool_result", "tool_use_id": i, "content": "x"}]}}


def text(role="assistant"):
    return {"type": role, "message": {"content": [{"type": "text", "text": "hi"}]}}


class Env:
    def __init__(self):
        self.td = tempfile.TemporaryDirectory()
        self.proj = os.path.join(self.td.name, "projects")
        self.pdir = os.path.join(self.proj, "-some-project")
        os.makedirs(self.pdir)

    def write(self, path, lines, mtime=None, raw=None):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            if raw is not None:
                f.write(raw)
            for d in lines:
                f.write((json.dumps(d) + "\n").encode())
        if mtime is not None:
            os.utime(path, (mtime, mtime))
        return path

    def main(self, lines, idle=1000, **kw):
        return self.write(os.path.join(self.pdir, SID + ".jsonl"), lines, NOW - idle, **kw)

    def agent(self, aid, lines, idle=5, meta=True, **kw):
        p = self.write(os.path.join(self.pdir, SID, "subagents", "agent-%s.jsonl" % aid), lines, NOW - idle, **kw)
        if meta:
            with open(p[:-6] + ".meta.json", "w") as f:
                json.dump({"agentType": "general-purpose", "description": "d"}, f)
        return p

    def run(self, *extra, sid=SID):
        r = subprocess.run([sys.executable, SCRIPT, sid, "--projects-dir", self.proj, "--now", str(NOW), *extra],
                           capture_output=True, text=True)
        return r

    def pulse(self, *extra):
        r = self.run(*extra)
        self.last = r
        assert r.returncode == 0, r.stderr
        return json.loads(r.stdout)

    def close(self):
        self.td.cleanup()


class T(unittest.TestCase):
    def setUp(self):
        self.e = Env()
        self.addCleanup(self.e.close)

    def test_quiet_main_active_subagent(self):
        self.e.main([text()], idle=3000)
        self.e.agent("a1", [text()], idle=5)
        o = self.e.pulse()
        self.assertTrue(o["available"])
        self.assertGreater(o["main"]["idleSeconds"], 2900)
        self.assertTrue(o["anyAgentWriting"])
        self.assertEqual(o["newestIdleSeconds"], 5)
        self.assertEqual(o["agents"][0]["id"], "a1")
        self.assertEqual(o["agents"][0]["agentType"], "general-purpose")

    def test_all_quiet(self):
        self.e.main([text()], idle=3000)
        self.e.agent("a1", [text()], idle=2500)
        o = self.e.pulse()
        self.assertFalse(o["anyAgentWriting"])
        self.assertEqual(o["newestIdleSeconds"], 2500)

    def test_tool_in_flight_and_resolved(self):
        self.e.main([text(), tool_use("t1", ts=NOW - 100)])
        o = self.e.pulse()
        self.assertTrue(o["main"]["toolInFlight"])
        self.assertEqual(o["main"]["toolInFlightSeconds"], 100)
        self.assertEqual(o["main"]["toolInFlightSource"], "line_timestamp")
        self.assertEqual(o["main"]["lastLineKind"], "tool_use")
        self.e.main([tool_use("t1"), tool_result("t1")])
        o = self.e.pulse()
        self.assertFalse(o["main"]["toolInFlight"])
        self.assertEqual(o["main"]["lastLineKind"], "tool_result")

    def test_tool_in_flight_without_timestamp_uses_mtime(self):
        d = tool_use("t1")
        del d["timestamp"]
        self.e.main([d], idle=77)
        o = self.e.pulse()
        self.assertEqual(o["main"]["toolInFlightSource"], "file_mtime")
        self.assertEqual(o["main"]["toolInFlightSeconds"], 77)

    def test_parallel_tools_one_unresolved(self):
        self.e.main([tool_use("a"), tool_use("b"), tool_result("a")])
        self.assertTrue(self.e.pulse()["main"]["toolInFlight"])

    def test_partial_last_line_is_not_unavailable(self):
        self.e.main([tool_use("t1"), tool_result("t1"), text()],
                    raw=None)
        with open(os.path.join(self.e.pdir, SID + ".jsonl"), "ab") as f:
            f.write(b'{"type": "assistant", "message": {"content": [{"type": "tex')
        o = self.e.pulse()
        self.assertTrue(o["available"])
        self.assertEqual(o["main"]["lastLineKind"], "assistant_text")

    def test_corrupted_line(self):
        self.e.main([text()], raw=None)
        with open(os.path.join(self.e.pdir, SID + ".jsonl"), "ab") as f:
            f.write(b"not json at all\n")
        o = self.e.pulse()
        self.assertTrue(o["available"])
        self.assertEqual(o["main"]["lastLineKind"], "unknown")

    def test_giant_final_line_is_unknown_not_empty(self):
        self.e.main([], raw=b'{"x": "' + b"a" * 200000 + b'"}\n')
        o = self.e.pulse()
        self.assertEqual(o["main"]["lastLineKind"], "unknown")

    def test_missing_session_and_missing_dir(self):
        o = self.e.pulse()
        self.assertFalse(o["available"])
        self.assertIn("reason", o)
        r = subprocess.run([sys.executable, SCRIPT, SID, "--projects-dir", "/nonexistent/x"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0)
        self.assertFalse(json.loads(r.stdout)["available"])

    def test_loop_of_identical_calls(self):
        lines = []
        for i in range(6):
            lines += [tool_use("t%d" % i, inp={"command": "ls"}), tool_result("t%d" % i)]
        self.e.main(lines)
        o = self.e.pulse()
        self.assertEqual(o["main"]["repeatedToolCalls"], 6)
        self.assertTrue(o["main"]["loopSuspected"])
        lines = []
        for i in range(6):
            lines += [tool_use("t%d" % i), tool_result("t%d" % i)]
        self.e.main(lines)
        self.assertEqual(self.e.pulse()["main"]["repeatedToolCalls"], 1)

    def test_two_agents(self):
        self.e.main([text()])
        self.e.agent("a1", [text()], idle=10)
        self.e.agent("a2", [tool_use("x")], idle=900)
        o = self.e.pulse()
        self.assertEqual([a["id"] for a in o["agents"]], ["a1", "a2"])
        self.assertTrue(o["anyAgentWriting"])
        self.assertTrue(o["agents"][1]["toolInFlight"])
        self.assertFalse(o["agents"][0]["toolInFlight"])

    def test_growth_vs_previous_and_null_without(self):
        self.e.main([text()])
        a = self.e.agent("a1", [text()])
        first = self.e.pulse()
        self.assertIsNone(first["main"]["grewSincePrevious"])
        self.assertIsNone(first["agents"][0]["grewSincePrevious"])
        snap = os.path.join(self.e.td.name, "snap.json")
        json.dump(first, open(snap, "w"))
        with open(a, "ab") as f:
            f.write((json.dumps(text()) + "\n").encode())
        o = self.e.pulse("--previous", snap)
        self.assertFalse(o["main"]["grewSincePrevious"])
        self.assertTrue(o["agents"][0]["grewSincePrevious"])
        # new agent not in snapshot counts as grown
        self.e.agent("a2", [text()])
        o = self.e.pulse("--previous", snap)
        self.assertTrue(next(x for x in o["agents"] if x["id"] == "a2")["grewSincePrevious"])

    def test_bad_previous_gives_null_not_false(self):
        self.e.main([text()])
        snap = os.path.join(self.e.td.name, "snap.json")
        open(snap, "w").write("{broken")
        o = self.e.pulse("--previous", snap)
        self.assertIsNone(o["main"]["grewSincePrevious"])
        self.assertTrue(o["warnings"])

    def test_path_separator_and_odd_ids_rejected(self):
        for bad in ["../x", "a/b", "..", "a\\b", ".hidden", "a b", "x\n"]:
            r = self.e.run(sid=bad)
            self.assertEqual(r.returncode, 2, bad)
            self.assertEqual(r.stdout, "")

    def test_no_args_is_exit_2(self):
        r = subprocess.run([sys.executable, SCRIPT], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)

    def test_symlink_outside_projects_dir_ignored(self):
        outside = os.path.join(self.e.td.name, "outside.jsonl")
        self.e.write(outside, [text()])
        os.symlink(outside, os.path.join(self.e.pdir, SID + ".jsonl"))
        o = self.e.pulse()
        self.assertFalse(o["available"])

    def test_vanishing_agent_file_does_not_crash(self):
        spec = importlib.util.spec_from_file_location("sp", SCRIPT)
        sp = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sp)
        info = sp.file_info(os.path.join(self.e.td.name, "gone.jsonl"), NOW, 5, None, False)
        self.assertIn("error", info)

    def test_huge_file_reads_only_tail(self):
        big = [text()] * 5 + [tool_use("t1")]
        raw = b"".join((json.dumps(text()) + "\n").encode() for _ in range(40000))  # several MB
        self.e.main(big, raw=raw)
        with open(os.path.join(self.e.pdir, SID + ".jsonl"), "ab") as f:
            f.write((json.dumps(tool_use("tail1")) + "\n").encode())
        t0 = time.time()
        o = self.e.pulse()
        self.assertGreater(o["main"]["size"], 1_000_000)
        self.assertTrue(o["main"]["toolInFlight"])
        self.assertLess(time.time() - t0, 5)

    def test_append_while_running(self):
        path = self.e.main([text()])
        stop = threading.Event()

        def writer():
            with open(path, "ab", buffering=0) as f:
                n = 0
                while not stop.is_set():
                    line = (json.dumps(tool_use("w%d" % n)) + "\n").encode()
                    f.write(line[: len(line) // 2])  # torn write
                    time.sleep(0.001)
                    f.write(line[len(line) // 2:])
                    n += 1

        th = threading.Thread(target=writer)
        th.start()
        try:
            for _ in range(15):
                o = self.e.pulse()
                self.assertTrue(o["available"])
                self.assertIn(o["main"]["lastLineKind"], ("tool_use", "assistant_text"))
        finally:
            stop.set()
            th.join()

    def test_file_growing_between_stat_and_read_is_not_reported_idle(self):
        path = self.e.main([text()], idle=1000)
        spec = importlib.util.spec_from_file_location("sp_grow", SCRIPT)
        sp = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sp)
        real_fstat = os.fstat
        calls = []

        def fstat(fd):
            st = real_fstat(fd)
            calls.append(1)
            if len(calls) == 1:  # a writer appends right after the first stat, before the read finishes
                with open(path, "ab") as f:
                    f.write((json.dumps(text()) + "\n").encode())
                os.utime(path, (NOW - 2, NOW - 2))
            return st

        sp.os = type("O", (), {})()
        for k in dir(os):
            setattr(sp.os, k, getattr(os, k))
        sp.os.fstat = fstat
        info = sp.file_info(path, NOW, 5, None, False)
        self.assertTrue(info["grewDuringRead"])
        self.assertLessEqual(info["idleSeconds"], 5)  # was 1000 before the second stat

    def test_untouched_file_reports_no_growth(self):
        self.e.main([text()], idle=1000)
        o = self.e.pulse()
        self.assertFalse(o["main"]["grewDuringRead"])
        self.assertEqual(o["main"]["idleSeconds"], 1000)


if __name__ == "__main__":
    unittest.main()
