#!/usr/bin/env python3
"""Bun Warmer's status line segment, for a Claude Code statusLine command.

Reads the JSON Claude Code passes a status line on stdin, takes its session_id,
reads that session's state file in ~/.claude/bun-warmer/ and prints one line, with
the countdowns worked out at the moment it runs:

    bun-warmer · warm · 2h10m left · ping in 37m

Prints nothing (and exits 0) when there is no session id, no state file, the file
cannot be read, or the mod is off for the session because its window ended,
/bunwarm off, /clear or session end. When the mod is on but not pinging (a 5-minute
or unknown cache), it prints the mod's own reason. Standard library only.
"""
import json
import math
import os
import sys
import time

HOUR_MS = 3600 * 1000


def safe_name(sid):
    """The state file name for a session id, as the mod writes it: letters, digits, _ and - stay, every other character is %XX per UTF-8 byte."""
    out = []
    for ch in sid:
        if ch.isascii() and (ch.isalnum() or ch in "_-"):
            out.append(ch)
        else:
            try:
                data = ch.encode("utf-8")
            except UnicodeEncodeError:  # a lone surrogate: the mod writes U+FFFD for it
                data = "\ufffd".encode("utf-8")
            out.extend("%%%02X" % b for b in data)
    return "".join(out)


def dur(seconds):
    # The hook's Math.max(0, Math.round(ms / 60000)): halves round up (Python's round() would round 2.5 to 2).
    total = max(0, math.floor(seconds / 60 + 0.5))
    h, m = divmod(total, 60)
    return "%dh%02dm" % (h, m) if h > 0 else "%dm" % m


def num(v):
    """A finite number from the state file, else 0: a malformed file never breaks the status line."""
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else 0


def ms(state, name):
    """`<name>EpochMs` when the file has it, else `<name>Epoch` seconds as milliseconds, else 0."""
    exact = num(state.get(name + "EpochMs"))
    return exact if exact else num(state.get(name + "Epoch")) * 1000


def segment(state, now):
    """The line for a parsed state file at `now` (epoch seconds), or '' for nothing to show. Judged as the hook judges it, in milliseconds."""
    if not isinstance(state, dict) or state.get("armed") is not True:
        return ""
    now_ms = now * 1000
    expires = ms(state, "expiresAt")
    if expires <= now_ms:
        return ""
    if state.get("statusState") == "off":
        text = state.get("statusText")
        return text if isinstance(text, str) else ""
    last_ping = state.get("lastPing") if isinstance(state.get("lastPing"), dict) else {}
    # The hook's lastWarmAt: activity or a ping that found the cache warm; a failed ping never counts. Files from before
    # lastWarmAtEpochMs existed fall back to activity or the last ping when it was good.
    warm_at = num(state.get("lastWarmAtEpochMs"))
    if not warm_at and "lastWarmAtEpochMs" not in state:
        good_ping = num(last_ping.get("atEpoch")) * 1000 if last_ping.get("ok") is True else 0
        warm_at = max(ms(state, "lastActivityAt"), good_ping)
    word = "idle" if not warm_at else ("cold" if now_ms - warm_at >= HOUR_MS else "warm")
    parts = ["bun-warmer", word, "%s left" % dur((expires - now_ms) / 1000)]
    next_ping = ms(state, "nextPingAt")
    # The mod's own words for what comes next, e.g. "context under 50,000 tokens, not pinging" or "quiet hours, pings resume 06:00".
    said = state.get("statusText").split(" · ") if isinstance(state.get("statusText"), str) else []
    # Used only when the mod saw the same state word, so a reason never outlives the state it was written for.
    reason = said[3] if len(said) > 3 and said[0] == "bun-warmer" and said[1] == word else ""
    if reason and not reason.startswith("ping in"):
        parts.append(reason)
    elif word == "warm" and next_ping > now_ms:
        parts.append("ping in %s" % dur((next_ping - now_ms) / 1000))
    if last_ping and last_ping.get("ok") is False:
        parts.append("last ping FAILED")
    stalled = state.get("stalledAgents")
    if isinstance(stalled, list) and stalled:
        parts.append("STALLED: %d subagent%s" % (len(stalled), "" if len(stalled) == 1 else "s"))
    return " · ".join(parts)


def main():
    try:
        sid = json.loads(sys.stdin.read() or "{}").get("session_id")
    except (ValueError, AttributeError):
        return 0
    home = os.environ.get("HOME")
    if not isinstance(sid, str) or not sid or not home:
        return 0
    path = os.path.join(home, ".claude", "bun-warmer", safe_name(sid) + ".json")
    try:
        with open(path, encoding="utf-8") as f:
            state = json.load(f)
    except (OSError, ValueError):
        return 0
    line = segment(state, time.time())
    if line:
        sys.stdout.write(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
