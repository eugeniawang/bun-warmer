# Bun Warmer

Bun Warmer is a mod for Claude Code users who take breaks during long sessions. Claude Code caches your conversation for 60 minutes. After a longer break, your next message re-writes the whole context at the cache-write rate, which is slow and costly. Bun Warmer sends a small ping after 50 minutes of quiet so the cache stays warm, for up to 90 minutes after your last prompt. It also flags subagents that go silent.

Inspired by [cache-tax](https://github.com/karanb192/cache-tax) by Karan Bansal (MIT). Bun Warmer is written from scratch; none of its code is copied.

## Requirements

- Claude Code with the function-hook mod (plugin) API, which is early access. The plugin does not declare a minimum version; it has been tested on Claude Code 2.1.302.
- A POSIX host (macOS or Linux). Bun Warmer builds paths with `/` and runs `mv`, `rm` and `test`, so it does not run on Windows.
- `python3` on your `PATH` for the transcript pulse (a small script that reads the session's local transcript files to confirm a subagent is still writing; `bin/session-pulse.py`, standard library only). Without it the stall watchdog still works from events alone.

## Install

1. Clone the repo to a folder of your choice:

```
git clone https://github.com/eugeniawang/bun-warmer.git /path/to/bun-warmer
```

`/path/to/bun-warmer` is a placeholder used throughout this README. Replace it with the absolute path where you cloned the repo, for example `/Users/<your-username>/code/bun-warmer` on macOS or `/home/<your-username>/bun-warmer` on Linux; use an absolute path, not `~` or a relative one. If the path is wrong, the mod does not load and `/bunwarm` does not respond; if the mod loads but cannot find its pulse script, the state file shows `pulse.reason` as `script-missing`, and a plugin folder that is not absolute is listed in `configWarnings`.

2. Try it for one session:

```
claude --plugin-dir /path/to/bun-warmer
```

3. To load it in every session, add its folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`. Use an absolute path. The value is a colon-joined list, so if you already load other folder mods, keep them: setting the variable to Bun Warmer's folder alone unloads every other folder mod that was in it. Read the current value first, then append:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "<existing folders, colon-joined>:/path/to/bun-warmer" } }
```

4. Start a new Claude Code session. A running session does not pick up a settings change.

5. Type `/bunwarm`. It answers `bun-warmer on, ... left`. You can also check that `~/.claude/bun-warmer/<session-id>.json` exists.

To uninstall, remove the folder from `CLAUDE_CODE_PLUGIN_DIRS` (or stop passing `--plugin-dir`) and start a new session.

### If you use cache-tax

Bun Warmer and cache-tax both ping, so load only one. Turn cache-tax off before you load Bun Warmer, for example `claude plugin disable cache-tax@claude-code-mods` (use the id `claude plugin list` shows for your install). To switch back, remove Bun Warmer and run `claude plugin enable` with the same id.

## Usage

Bun Warmer arms itself when a session starts and when you type a prompt. You do not need to do anything else.

Slash command:

| Command | What it does |
|---|---|
| `/bunwarm` | Shows status: time left in the window, failed or refused pings, pings skipped for quiet hours |
| `/bunwarm off` | Stops Bun Warmer for this session |
| `/bunwarm on` | Starts a fresh window for this session |

The status line shows the state, the time left in the window, and what happens next:

```
bun-warmer · idle · 1h30m left · waiting for the first turn
bun-warmer · warm · 1h25m left · ping in 50m
bun-warmer · cold · 20m left · cache cold, waiting for activity
```

- `idle` means no turn has happened yet.
- `warm` means there was activity or a successful ping in the last 60 minutes.
- `cold` means 60 minutes have passed with no activity or successful ping.

The last part can also read `quiet hours, pings resume 06:00`, `context under 50,000 tokens, not pinging`, or `context size unknown, not pinging`. A failed ping adds `last ping FAILED: <reason>`, and a silent subagent adds `STALLED: <id> <N>m`. When the mod is off, the line reads `bun-warmer off: <reason>`.

## Configuration

An environment variable beats the matching config menu value. The config menu fields (`intervalMin`, `windowMin`, `minTokens`, `guard`) appear in the Claude Code plugin config menu; for a folder-loaded plugin they are stored in settings under `pluginConfigs`, keyed `bun-warmer@inline`.

| Setting | Default | How to set it |
|---|---|---|
| Ping interval | 50 minutes, capped at 55 | env `BUN_WARMER_INTERVAL_MIN`, or config `intervalMin` |
| Keep-warm window | 90 minutes | env `BUN_WARMER_WINDOW_HOURS` (hours), else env `BUN_WARMER_WINDOW_MIN`, else config `windowMin` |
| Hard cap on window extensions | 12 hours | env `BUN_WARMER_MAX_HOURS` |
| Minimum context to ping or warn | 50,000 tokens | env `BUN_WARMER_MIN_TOKENS`, or config `minTokens` |
| Cold-send guard (what happens when you type into a cold cache) | `warn` | config `guard`: `warn` or `refuse` |
| First active hour | 6 | env `BUN_WARMER_ACTIVE_START` (0-23) |
| First quiet hour | 23 | env `BUN_WARMER_ACTIVE_END` (0-23, exclusive) |
| Quiet hours | on | env `BUN_WARMER_QUIET_HOURS=off` pings around the clock, still inside the window |
| Stall threshold | 20 minutes | env `BUN_WARMER_STALL_MIN` |
| Stall check interval | 5 minutes | env `BUN_WARMER_STALL_CHECK_MIN` |
| Pulse script path | `<plugin folder>/bin/session-pulse.py` | env `BUN_WARMER_PULSE` (absolute path ending in `.py`) |

Allowed ranges: window 1 to 720 minutes (`BUN_WARMER_WINDOW_HOURS` 1/60 to 12), ping interval 5 to 240 minutes (then capped at 55), hard cap 1 to 48 hours, minimum tokens 0 to 2,000,000, stall threshold 1 to 720 minutes, stall check interval 1 to 60 minutes, active hours whole numbers 0 to 23. A value outside its range, or one that is not a number, is ignored and the next source or the default applies. The variable's name (never its value) is added to `configWarnings` in the state file. A value that is clamped, such as an interval above 55, also adds a line there.

Active hours: a start greater than the end wraps midnight (22 and 6 means active from 22:00 to 05:59). A start equal to the end means no restriction.

## How it works

### Pings

After the ping interval passes with no activity, Bun Warmer sends a short, tool-less ping through `$.model.fork`. The ping reads the cache, which resets its 60-minute lifetime. Pings continue for the window after your last typed prompt.

Bun Warmer never pings:

- a cache that is already cold (60 minutes since any activity), because the ping would pay the full re-write;
- a session whose context is under the minimum token count, or whose size is not yet known (the size comes from `$.session.usage()` after each response);
- during quiet hours (06:00 to 23:00 local time is active by default).

A ping that fails, is refused, or finds the cache already gone is recorded as failed in the state file and the status line. It is never reported as a success. A ping's own model call does not count as activity, so pings never extend the window.

### Subagents and the window

Subagent turns count as activity. When the window ends while a subagent is still `running`, or turns arrived within the last interval, the window is extended instead of closed. Agents with status `pending` or `waiting` do not extend it, because an abandoned one could wait forever. Extensions stop at the hard cap (default 12 hours after the window started); at the cap Bun Warmer turns itself off.

### Cold-send guard

The cache counts as warm when there was activity or a successful ping within the last 60 minutes; a failed ping does not count. When you type a prompt into a session whose cache has gone cold, the guard notes how many tokens the send will re-write. In the default `warn` mode it only logs that note. In `refuse` mode it drops your first send once with that note; send again to go ahead. It drops only once per cold period: after the next activity or successful ping, a later cold period is guarded again. The guard only looks at prompts a person typed (origins `composer` and `bridge`). Subagent returns, task notifications, scheduled prompts, SDK and plugin messages always pass through. Bun Warmer does not know model prices, so it shows tokens, not dollars.

### Quiet hours

Quiet hours use the local time of the machine Claude Code runs on, including daylight saving time. A ping that comes due during quiet hours is skipped and counted in `skippedQuiet`; it is not a failure. In practice the cache goes cold overnight, and the first prompt you type in the morning pays one re-write. Quiet hours are an extra limit on top of the window, never a replacement: an idle session started at 07:00 pings at 07:50 and stops when its window ends at 08:30.

### `/clear`, resume and compaction

`/clear` and an in-process resume both reset everything Bun Warmer knows about the old session, and a ping that was in flight when that happened is discarded. They differ in what comes next:

- `/clear` leaves the old session's state file with `armed: false` and `note: "cleared"`. The mod stays off until you type a prompt, which arms a new window under the new session id.
- An in-process `/resume` (typed inside a running Claude Code) does not fire the plugin's `session.start`, because that hook fires once per process. The old state file is left with `armed: false`, and the mod stays off until you type a prompt, which arms a new window under the resumed session id.
- Starting a new process with `claude --resume` (or `claude --continue`) does fire `session.start`, so the mod arms right away, without waiting for a prompt. The old session's state file is left with `armed: false` and `note: "session ended"`.

Compaction clears the remembered context size until the next response, so the guard never acts on the old count.

### Stall watchdog

While a session has subagents, a second timer checks `$.agent.list()` every 5 minutes. This call is local and costs no tokens. A `running` subagent that has produced no events and has no tool call in flight for 20 minutes is flagged as stalled. A tool call that is still running counts as activity for as long as it runs.

The transcript pulse is a second signal. On each check that finds at least one subagent with status `running`, Bun Warmer runs `python3 <plugin folder>/bin/session-pulse.py <session-id>` (no shell, 10-second timeout). The script reads the tail of the session's transcript files and reports how long each subagent's transcript has been idle. A subagent is flagged only when both the events and the transcript say it has been quiet longer than the threshold. If the pulse is not available, events decide alone and the state file records why. `script-missing` is recorded only after such a check, so it does not appear while no subagent is running. See [`bin/README-session-pulse.md`](bin/README-session-pulse.md) for the script's output.

Each stall is reported once. Bun Warmer adds it to the state file and the status line, and sends one message to the main conversation through `$.prompt.submit`. The message is fixed text plus a sanitized agent id, an allowlisted agent type, the minutes silent and the local time. It tells the model to check the agent in its own Agent list and not to stop or respawn it on this notice alone. The agent's free-text description is never put in the message, because it can contain instructions. Pulse output is treated as untrusted. Its string ids are used only to match the agent ids the engine reports and are never shown; its numbers and booleans drive the stall decision.

The message is sent only while the main conversation is idle. While a main turn is running, the message waits until that turn ends. The watchdog never stops or kills anything.

## State file

Each session writes `~/.claude/bun-warmer/<session-id>.json` on every arm, disarm, ping and activity event. The file is for you and your scripts to read; nothing in Bun Warmer depends on it. It is written to a temporary file and moved into place, so a reader never sees half a file.

```json
{
  "sessionId": "…",
  "writtenAt": "…", "writtenAtEpoch": 0, "writtenAtEpochMs": 0,
  "armed": true,
  "armedAt": "…",          "armedAtEpoch": 0,
  "windowStartAt": "…",    "windowStartAtEpoch": 0,
  "lastPingAt": "…",       "lastPingAtEpoch": 0,
  "lastActivityAt": "…",   "lastActivityAtEpoch": 0,
  "expiresAt": "…",        "expiresAtEpoch": 0,
  "refusals": 0,
  "guardDrops": 0,
  "quietHours": { "enabled": true, "activeStartHour": 6, "activeEndHour": 23 },
  "skippedQuiet": 0,
  "lastSkippedAt": null,   "lastSkippedAtEpoch": null,
  "lastPing": { "at": "…", "atEpoch": 0, "ok": true, "reason": null, "cacheReadTokens": 0, "cacheWriteTokens": 0 },
  "intervalMin": 50,
  "windowMin": 90, "windowHours": 1.5,
  "minTokens": 50000, "contextTokens": 200000, "skippedSmall": 0,
  "pulse": { "available": true, "reason": null, "checkedAt": "…", "checkedAtEpoch": 0, "agentsSeen": 1 },
  "maxHours": 12,
  "configWarnings": [],
  "note": null,
  "stallMin": 20,
  "stallCheckMin": 5,
  "stalledAgents": [
    { "id": "…", "description": "…", "type": "general-purpose", "minutesSilent": 22, "firstFlaggedAt": "…", "firstFlaggedAtEpoch": 0, "messageSent": true }
  ]
}
```

Notes for readers of the file:

- Use `lastActivityAt` for real activity. Pings move `lastPingAt` only.
- Time fields are `null` until the event has happened. `contextTokens` is `null` while the size is unknown.
- `armed` is `false` after the window ends, `/bunwarm off`, `/clear` or session end, and `note` says which.
- `refusals` counts pings that failed or were refused. `guardDrops` counts prompts dropped in `refuse` mode. `skippedSmall` counts pings skipped because the context was too small or its size unknown.
- `messageSent` is `null` while a stall message waits for an idle main conversation, and `false` if sending failed.
- Check freshness with `writtenAtEpochMs`. Treat a file older than the ping interval as out of date.

File name: a UUID session id is used as is. Any other character outside `A-Z a-z 0-9 _ -` becomes `%` plus two uppercase hex digits per UTF-8 byte (`a/b` becomes `a%2Fb`).

If a write fails, the old file is kept and `<session-id>.error.json` is written beside it with the error and the time. The next successful write removes it. If the error file cannot be written either, Bun Warmer tries to remove the old state file so you do not read a stale one as current. If that fails too, the status line says `STATE FILE NOT WRITTEN`, and only the age of `writtenAtEpochMs` shows the file is stale.

## Limitations

- The mod API cannot withdraw a queued prompt. Bun Warmer re-checks its state just before it sends a stall message, but if you run `/bunwarm off` or `/clear` in that instant, one stall message can still arrive late. The message starts with the time it was sent and says to ignore it if the mod was turned off or the subagent has finished.
- If a turn's completion event is never delivered, Bun Warmer keeps treating the main conversation as busy and holds stall messages until the session resets.
- A ping's events carry no marker. While a ping is in flight, a main-conversation event with no agent id is taken for the ping's and ignored. The next event after the ping counts.
- A subagent that streams for a long time inside one model step, with no tool call, can look quiet to the watchdog.
- The transcript layout the pulse reads is not a public Claude Code contract and may change. Idle times come from the wall clock, so they jump after the machine sleeps.
- The transcript pulse finds a subagent by matching the id `$.agent.list()` gives to a transcript file name. If your Claude Code version names the files differently, or the match is ambiguous, the pulse cannot confirm or clear a stall for that subagent. Events alone then decide, so a subagent that is still writing to its transcript can be flagged as stalled.
- If `$.agent.list()` is unavailable or fails, the stall check for that pass is skipped and nothing is flagged, and a running subagent does not extend the window when it ends.
- Quiet hours follow the time zone of the process running the mod. A host that runs mods in a different zone would shift the hours.
- There is no API call to close a session, so Bun Warmer never closes one.
- Workflow agents do not appear in `$.agent.list()` or in the transcript layout, so the watchdog cannot see them.

## Testing

```
claude plugin validate .
claude plugin test .
TZ=UTC claude plugin test .
python3 -m unittest discover -s tests/pulse
```

The tests build times from local calendar fields, so run them under more than one time zone.

## License

License: not yet chosen.
