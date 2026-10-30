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
import os
import sys
import time

HOUR = 3600


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
    total = max(0, round(seconds / 60))
    h, m = divmod(total, 60)
    return "%dh%02dm" % (h, m) if h > 0 else "%dm" % m


def segment(state, now):
    """The line for a parsed state file at `now` (epoch seconds), or '' for nothing to show."""
    if not isinstance(state, dict) or state.get("armed") is not True:
        return ""
    expires = state.get("expiresAtEpoch") or 0
    if not isinstance(expires, (int, float)) or expires <= now:
        return ""
    if state.get("statusState") == "off":
        text = state.get("statusText")
        return text if isinstance(text, str) else ""
    last_ping = state.get("lastPing") if isinstance(state.get("lastPing"), dict) else {}
    activity = state.get("lastActivityAtEpoch") or 0
    good_ping = (last_ping.get("atEpoch") or 0) if last_ping.get("ok") is True else 0
    warm_at = max(activity, good_ping)
    word = "idle" if not warm_at else ("cold" if now - warm_at >= HOUR else "warm")
    parts = ["bun-warmer", word, "%s left" % dur(expires - now)]
    next_ping = state.get("nextPingAtEpoch") or 0
    # The mod's own words for what comes next, e.g. "context under 50,000 tokens, not pinging" or "quiet hours, pings resume 06:00".
    said = state.get("statusText").split(" · ") if isinstance(state.get("statusText"), str) else []
    # Used only when the mod saw the same state word, so a reason never outlives the state it was written for.
    reason = said[3] if len(said) > 3 and said[0] == "bun-warmer" and said[1] == word else ""
    if reason and not reason.startswith("ping in"):
        parts.append(reason)
    elif word == "warm" and isinstance(next_ping, (int, float)) and next_ping > now:
        parts.append("ping in %s" % dur(next_ping - now))
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
