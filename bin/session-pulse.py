#!/usr/bin/env python3
"""session-pulse: report whether a Claude Code session or its subagents are still writing.

Reads only the tail of raw transcripts. Stateless, no network, no model, no logging.
Exit 0 with {"available": false, ...} when it cannot tell; exit 2 only for bad arguments.
"""
import argparse
import glob
import json
import os
import re
import sys
import time
from datetime import datetime

PULSE_VERSION = 1
TAIL_BYTES = 64 * 1024
AGENT_WRITING_WINDOW = 60
SESSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


class BadArgs(Exception):
    pass


def parse_ts(s):
    if not isinstance(s, str):
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def read_tail(path):
    """Return (lines, size, mtime, grew). Drops a partial first line (when seeked) and a partial last line.

    A file being appended to can grow between fstat() and read(). After the read it is stat'ed again; if size or mtime moved,
    the newer values are returned and grew is True, so a writer in the middle of appending is never reported by its old mtime.
    """
    with open(path, "rb") as f:
        st = os.fstat(f.fileno())
        size = st.st_size
        start = max(0, size - TAIL_BYTES)
        f.seek(start)
        data = f.read(TAIL_BYTES)
        st2 = os.fstat(f.fileno())
    grew = (st2.st_size, st2.st_mtime) != (st.st_size, st.st_mtime)
    if grew:
        st = st2
        size = max(size, st2.st_size)
    lines = data.split(b"\n")
    # The last element is either "" (file ends with newline) or an incomplete line: drop it either way.
    lines = lines[:-1]
    if start > 0 and lines:
        lines = lines[1:]  # first line may have been cut by the seek
    return lines, size, st.st_mtime, grew


def classify(d):
    """Kind of one parsed line."""
    if not isinstance(d, dict):
        return "unknown"
    t = d.get("type")
    msg = d.get("message")
    content = msg.get("content") if isinstance(msg, dict) else None
    if t in ("assistant", "user") and isinstance(content, list) and content:
        bt = content[-1].get("type") if isinstance(content[-1], dict) else None
        if t == "assistant":
            return {"tool_use": "tool_use", "thinking": "assistant_thinking", "text": "assistant_text"}.get(bt, "assistant_other")
        return {"tool_result": "tool_result", "text": "user_text"}.get(bt, "user_other")
    if t in ("assistant", "user"):
        return t + "_text"
    return "other:%s" % t if isinstance(t, str) else "unknown"


def analyze_tail(lines, mtime, loop_n, empty_ok=True):
    parsed = []
    for raw in lines:
        if not raw.strip():
            continue
        try:
            parsed.append(json.loads(raw))
        except (ValueError, UnicodeDecodeError):
            parsed.append(None)
    last_kind = classify(parsed[-1]) if parsed else ("empty" if empty_ok else "unknown")
    if parsed and parsed[-1] is None:
        last_kind = "unknown"
    conv_kind = None
    for d in reversed(parsed):
        if isinstance(d, dict) and d.get("type") in ("assistant", "user"):
            conv_kind = classify(d)
            break
    open_calls = {}  # id -> (ts or None, order)
    runs, cur_key, cur_len, max_run = 0, None, 0, 0
    for d in parsed:
        if not isinstance(d, dict) or d.get("type") not in ("assistant", "user"):
            continue
        msg = d.get("message")
        content = msg.get("content") if isinstance(msg, dict) else None
        if not isinstance(content, list):
            continue
        for b in content:
            if not isinstance(b, dict):
                continue
            if d["type"] == "assistant" and b.get("type") == "tool_use":
                open_calls[b.get("id")] = parse_ts(d.get("timestamp"))
                try:
                    key = (b.get("name"), json.dumps(b.get("input"), sort_keys=True))
                except (TypeError, ValueError):
                    key = (b.get("name"), repr(b.get("input")))
                cur_len = cur_len + 1 if key == cur_key else 1
                cur_key = key
                max_run = max(max_run, cur_len)
            elif d["type"] == "user" and b.get("type") == "tool_result":
                open_calls.pop(b.get("tool_use_id"), None)
    return {
        "lastLineKind": last_kind,
        "lastConversationKind": conv_kind,
        "open": open_calls,
        "repeated": max_run,
    }


def file_info(path, now, loop_n, prev_size, have_prev):
    try:
        lines, size, mtime, grew = read_tail(path)
    except OSError as e:
        return {"path": path, "error": "unreadable: %s" % type(e).__name__}
    a = analyze_tail(lines, mtime, loop_n, empty_ok=(size == 0))
    info = {
        "path": path,
        "mtime": mtime,
        "size": size,
        "idleSeconds": max(0.0, round(now - mtime, 3)),
        "grewDuringRead": grew,
        "lastLineKind": a["lastLineKind"],
        "lastConversationKind": a["lastConversationKind"],
        "toolInFlight": bool(a["open"]),
        "toolInFlightSeconds": None,
        "toolInFlightSource": None,
        "repeatedToolCalls": a["repeated"],
        "loopSuspected": a["repeated"] >= loop_n,
    }
    if a["open"]:
        # Most recent open tool_use; use its own timestamp if present, else the file mtime.
        stamped = [t for t in a["open"].values() if t is not None]
        if stamped:
            info["toolInFlightSeconds"] = round(now - max(stamped), 3)
            info["toolInFlightSource"] = "line_timestamp"
        else:
            info["toolInFlightSeconds"] = round(now - mtime, 3)
            info["toolInFlightSource"] = "file_mtime"
    if have_prev:
        if prev_size is None:
            info["grewSincePrevious"] = True  # not in the snapshot: new file
        elif size > prev_size:
            info["grewSincePrevious"] = True
        elif size == prev_size:
            info["grewSincePrevious"] = False
        else:
            info["grewSincePrevious"] = None  # shrank: cannot say
    else:
        info["grewSincePrevious"] = None
    return info


def safe_path(path, root_real):
    """Skip symlinks that point outside the projects dir."""
    real = os.path.realpath(path)
    return real == root_real or real.startswith(root_real + os.sep)


def pulse(session_id, projects_dir, previous, now, loop_n):
    out = {"available": False, "sessionId": session_id, "now": now, "pulseVersion": PULSE_VERSION}
    warnings = []
    if not os.path.isdir(projects_dir):
        out["reason"] = "projects dir missing or not a directory"
        return out
    root_real = os.path.realpath(projects_dir)
    cands = [p for p in glob.glob(os.path.join(glob.escape(projects_dir), "*", session_id + ".jsonl")) if os.path.isfile(p) and safe_path(p, root_real)]
    if not cands:
        out["reason"] = "no transcript found for session id"
        return out
    if len(cands) > 1:
        warnings.append("multiple transcripts matched; using the newest")
        cands.sort(key=lambda p: os.stat(p).st_mtime, reverse=True)
    main_path = cands[0]

    have_prev = False
    prev_sizes = {}
    if previous is not None:
        if isinstance(previous, dict) and previous.get("sessionId") == session_id and previous.get("available") is True:
            have_prev = True
            m = previous.get("main") or {}
            if "path" in m:
                prev_sizes[m["path"]] = m.get("size")
            for a in previous.get("agents") or []:
                if isinstance(a, dict) and "path" in a:
                    prev_sizes[a["path"]] = a.get("size")
        else:
            warnings.append("previous snapshot ignored (wrong session or not an available pulse)")

    main = file_info(main_path, now, loop_n, prev_sizes.get(main_path), have_prev)
    if "error" in main:
        out["reason"] = "main transcript " + main["error"]
        return out

    agents = []
    sub_glob = os.path.join(os.path.dirname(main_path), glob.escape(session_id), "subagents", "agent-*.jsonl")
    for p in sorted(glob.glob(sub_glob)):
        if not os.path.isfile(p) or not safe_path(p, root_real):
            continue
        info = file_info(p, now, loop_n, prev_sizes.get(p), have_prev)
        base = os.path.basename(p)
        info["id"] = base[len("agent-"):-len(".jsonl")]
        meta_path = p[:-len(".jsonl")] + ".meta.json"
        try:
            with open(meta_path, "rb") as f:
                meta = json.loads(f.read(65536))
            info["agentType"] = meta.get("agentType")
            info["description"] = meta.get("description")
        except (OSError, ValueError):
            pass
        agents.append(info)

    good = [x for x in agents if "error" not in x]
    for x in agents:
        if "error" in x:
            warnings.append("agent %s: %s" % (x["id"], x["error"]))
    writes = [main["mtime"]] + [x["mtime"] for x in good]
    newest = max(writes)
    if any(w > now + 1 for w in writes):
        warnings.append("a file mtime is in the future: clock skew or wall-clock jump")
    out.update({
        "available": True,
        "main": main,
        "agents": agents,
        "newestWriteAt": newest,
        "newestIdleSeconds": round(now - newest, 3),
        "anyAgentWriting": any(0 <= x["idleSeconds"] <= AGENT_WRITING_WINDOW for x in good),
        "warnings": warnings,
    })
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="Report transcript activity for a Claude Code session.")
    ap.add_argument("session_id")
    ap.add_argument("--projects-dir", default=os.path.expanduser("~/.claude/projects"))
    ap.add_argument("--previous")
    ap.add_argument("--now", type=float)
    ap.add_argument("--loop-threshold", type=int, default=5)
    try:
        args = ap.parse_args(argv)
        sid = args.session_id
        if not SESSION_RE.fullmatch(sid) or ".." in sid or len(sid) > 200:
            raise BadArgs("invalid session id (path separators and odd characters are rejected)")
        if args.loop_threshold < 2:
            raise BadArgs("--loop-threshold must be >= 2")
    except BadArgs as e:
        print("session-pulse: %s" % e, file=sys.stderr)
        return 2
    except SystemExit as e:
        return 2 if e.code else 0
    previous = None
    if args.previous:
        try:
            with open(args.previous, "rb") as f:
                previous = json.loads(f.read(4 * 1024 * 1024))
        except (OSError, ValueError):
            previous = {}  # unreadable snapshot: treated as ignored, with a warning
    now = args.now if args.now is not None else time.time()
    try:
        res = pulse(sid, os.path.expanduser(args.projects_dir), previous, now, args.loop_threshold)
    except Exception as e:  # never crash into silence: report unavailable
        res = {"available": False, "reason": "internal error: %s" % type(e).__name__, "sessionId": sid, "now": now, "pulseVersion": PULSE_VERSION}
    print(json.dumps(res, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
