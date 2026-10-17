# Bun Warmer

A Claude Code mod that keeps the prompt cache warm during breaks, so the next message reads the cache instead of re-writing it.

Inspired by cache-tax by Karan Bansal (MIT, https://github.com/karanb192/cache-tax). Bun Warmer is written from scratch; none of his code is copied.

Requires Claude Code 2.1.300 or newer (function hooks, early-access API).

## What it does

- Arms itself when a session starts. After the interval of quiet (default 50 minutes) it sends a tool-less ping with `$.model.fork`, which reads the cache and refreshes its one-hour lifetime. Pings continue for the window (default 90 minutes) after your last typed prompt, and only for a session whose context is at least `BUN_WARMER_MIN_TOKENS` (default 50,000 tokens) (see Size gate).
- A cold cache (60 minutes since any activity) is never pinged, because that would pay the full rewrite.
- Subagent activity counts as main-session activity. Any turn step or turn completion carrying an `agentId` updates `lastActivityAt`. At window expiry the window is extended instead of closed while turns arrived within the last interval or a subagent has status `running`. `pending` and `waiting` agents (for example one waiting on a plan approval) never extend it, because an abandoned one could wait forever. Extensions have a hard cap: the window can never reach past `BUN_WARMER_MAX_HOURS` (default 12) after the start of the current window (session start, a typed prompt, or `/bunwarm on`). At the cap the mod disarms with `note: "maximum of 12h00m reached"`, whatever is still running.
- The cold-send guard only ever looks at prompts a person typed (origin `composer` or `bridge`). Every other origin passes through untouched: `sdk`, `task-notification`, `scheduled-trigger`, `peer`, `peer-send-message`, `projects-relay`, `channel`, `coordinator`, `observer`, `observer-activity`, `auto-continuation`, `unclassified`, `slack-ping`, `plugin`. The default guard mode is `warn` (a note with the token count, never a drop). `refuse` is opt-in and drops only a human first send once.
- `/clear` ends the session without a `session.start`. Bun Warmer resets everything about the old session (context size, activity times, ping record, counters, stalled agents), leaves the old session's state file as `armed: false` with `note: "cleared"`, and takes the new session id from the next event it sees. It stays disarmed until you type a prompt. The same reset runs on resume and whenever an event arrives under a session id different from the one it holds.
- Compaction (`session.compact`, main conversation only, not a skip) clears the remembered context size and the guard's acknowledgement, so the cold-send guard cannot act on the pre-compaction count. The size is set again only by the next response (`turn.complete`).
- A ping's own model call is never session activity, and a subagent's work during a ping always is. The API puts no marker on a fork's events, so while a ping is in flight an event with no `agentId` is taken for the ping's and ignored; an event carrying the `agentId` of a subagent that `$.agent.list()` names (a real subagent turn step, turn completion or tool completion) moves `lastActivityAt` as usual. An `agentId` that no list names (an engine fork) is ignored. The residual: real main-conversation activity that has no `agentId` and lands inside the few seconds of a ping is also ignored; the next event after the ping counts. `lastPingAt` is a separate field. A reader of the state file that wants real activity should use `lastActivityAt`, which the pings do not move.
- Each session has a generation number that `/clear`, resume and session end bump. A ping that was out when that happened is discarded when its answer arrives: it does not write a result, a refusal count or a state file for the new session, and the ping-in-flight flag is cleared at the reset so the new session's first ping is never skipped. A timer that fires while a ping is still out reschedules itself instead of dropping the schedule. `lastActivityAt` is therefore never moved by the pings.
- A ping that fails, is refused, or finds the cache already gone is recorded as failed in the state file and shown in the status line. It is never reported as success.
- The mod does not know model prices, so the guard note shows the token count that would be re-written, not a dollar figure.

Timer callbacks (the ping timer and the watchdog timer) have rejection handlers that log `bun-warmer: tick failed (...)` or `stall check failed (...)` through a logger that never throws, so a clock or UI call that fails during teardown cannot become an unhandled rejection. No automated test covers this: the test kit lets one hook answer `clock.now` and `mock.clock` holds it.

## Quiet hours

Pings go out only during the day, 06:00 to 23:00 in the local time of the machine the session runs on (not a fixed zone). The mod reads the time with `$.clock.now()` (epoch milliseconds) and turns it into an hour with the JavaScript `Date` local getters (`getHours`). Confirmed: the unit tests, which build every time from local calendar fields, pass under `TZ=America/Los_Angeles`, `UTC`, `Asia/Kolkata` and `Australia/Lord_Howe`, so the module follows the process zone, including DST. Not checked: a live Claude Code session. The types file offers no zone-aware clock call, so a host that ran the mod in a sandbox with a different zone than the machine would shift the hours.

Quiet hours are a second limit on top of the window, never a replacement for it. A session pings only while it is within the window (default 90 minutes) of its last real activity; a ping never extends the window (the ping's own model call is not activity); subagent activity still extends it. With the default window, a session started at 07:00 and left idle pings at 07:50 and then stops when the window ends at 08:30, not at 23:00 (the test `a session started at 07:00 and left idle stops pinging 3 hours after its last activity` covers the same rule with a 3-hour window set through `BUN_WARMER_WINDOW_HOURS`).

| Setting | Default | Meaning |
|---|---|---|
| env `BUN_WARMER_ACTIVE_START` | 6 | First active hour, 0-23 |
| env `BUN_WARMER_ACTIVE_END` | 23 | First quiet hour, 0-23, exclusive (23 means the last ping is allowed at 22:59) |
| env `BUN_WARMER_QUIET_HOURS` | on | `off` turns the schedule off and pings run around the clock, still inside the window |

A start greater than the end wraps midnight (22 and 6 means active from 22:00 to 05:59). A start equal to the end means no restriction. A value that is not a whole number from 0 to 23 is ignored and the default is used.

A ping that comes due during quiet hours is skipped: `skippedQuiet` goes up by one, `lastSkippedAt` records when, and the status line says `quiet hours, pings resume 06:00`. A skip is not a failure and not a refusal: `refusals` and `lastPing` are not touched. The next ping is scheduled for the first moment inside active hours or the normal interval after the skip, whichever is later. Because a cache that has been idle for 60 minutes is never pinged, a skipped ping normally means the cache goes cold, and the next ping happens only after new activity. `expiresAt` in the state file is still the end of the window, unchanged by quiet hours.

What this means for overnight orchestrator runs: the cache is allowed to go cold on purpose. An orchestrator that works through the night with subagents keeps the session busy, but Bun Warmer sends no pings between 23:00 and 06:00, so the cache expires after 60 minutes without a model call. The guard does not drop non-human messages (subagent returns, task notifications, schedules, the SDK) and quiet hours do not change the guard at all (default `warn`). The first message a person types the next morning pays one re-warm of the whole context at the cache-write rate.

Pings that resume at 06:00 need both an open window and a warm cache. An overnight run whose subagents are still active at 05:30 and whose window is open does get a ping at 06:20.

## Size gate

A ping, and the cold-cache warning, apply only to a session whose context is at least `BUN_WARMER_MIN_TOKENS` tokens (default 50,000). The size is the context token count the engine reports after a response (`$.session.usage()`), read at session start and after every completed turn. Before the first response the size is not known, and a session with an unknown size is not pinged and gets no warning. The same value is the guard threshold, so the warning and the ping never disagree. The comparison is "at least": 49,999 does nothing, 50,000 and above acts. A ping that comes due for a session below the threshold is skipped, counted in `skippedSmall` in the state file, and not retried sooner than one interval later; the status line says `context under 50,000 tokens, not pinging` or `context size unknown, not pinging`. A compaction or `/clear` sets the size back to unknown until the next response.

## Stall watchdog

While a session has subagents, a second timer (separate from the ping) checks `$.agent.list()` every `BUN_WARMER_STALL_CHECK_MIN` minutes (default 5). The call is local and costs no tokens. A subagent whose status is `running` and that has produced no event (turn step, turn completion, tool call start or finish) and has no tool call in flight for `BUN_WARMER_STALL_MIN` minutes (default 20) is stalled. A tool call that has started and not finished counts as active for as long as it runs, however long, and its completion restarts the clock; a model step that streams for a long time without a tool call can still look quiet. An agent never seen producing an event is timed from the first check that saw it running. The transcript pulse (below) is a second signal. The watchdog never stops or kills anything. It runs only while the mod is armed: `/bunwarm off`, window expiry, `/clear` and session end all stop its timer (and clear its stalled list), and `/bunwarm on` or a typed prompt starts it again.

### Transcript pulse (second signal)

On each stall check, while at least one agent is running, the mod runs `python3 <path to session-pulse.py> <session-id>` through `$.process.run` as an argv vector (no shell, timeout 10 seconds, and the check never waits on it longer than that). The script reads the tail of the session's transcript files and reports how many seconds each subagent's transcript has been idle and whether a tool call is in flight (see `bin/README-session-pulse.md`). The pulse is never the only signal. An agent is silent only if BOTH the event-based silence and the pulse (transcript idle seconds, no tool in flight) are longer than the stall threshold. So an agent that is quiet by events but whose transcript is still being written is not flagged, and a flagged agent clears when its transcript starts moving.

If the pulse is not available (the script reports `available: false`, the script is missing, it exits non-zero, it takes more than 10 seconds, its output does not parse, or it does not list that agent) the event-based signal decides alone, and the state file records `pulse: { available: false, reason, ... }`. Reason words are fixed by the mod: `script-missing`, `timeout`, `nonzero-exit`, `unparseable`, `pulse-reported-unavailable`, `no-session-id`, `run-failed`.

Pulse output is untrusted text. The mod keeps only finite numbers and booleans from it (idle seconds, tool in flight). No string from the pulse (a reason, a description, a path) reaches a prompt, the status line, a log line or the state file; the pulse's `grewDuringRead` and `uncertain` flags are read, and a reading carrying either is treated as written just now (the agent is not silent).

Script path, first hit wins (each is checked with `test -f`): environment `BUN_WARMER_PULSE` (must be an absolute path starting with `/` and ending in `.py`; anything else, such as `./session-pulse.py`, is skipped, never run, and recorded in `configWarnings` in the state file); `bin/session-pulse.py` inside the plugin's own folder (the API exposes it as `$.plugin.root`, Confirmed in the types file).

Not checked: that the id `$.agent.list()` gives an agent equals the `agent-<id>` file name the pulse reports (Not checked live. The mod matches exactly, one direction only: a listed id `x` finds the pulse entry `x`, or else `agent-x`; it never strips a prefix from the listed id, so `a1` and `agent-a1` stay two agents. If the pulse has both forms, a duplicate id, or `agent-x` is itself a listed id, the match is ambiguous and the pulse is ignored for that agent: events alone decide.) An agent the pulse does not list is judged by events alone. The wall-clock caveat in `bin/README-session-pulse.md` (idle times jump after the Mac sleeps) applies to the pulse signal.

Each stall is reported once. The watchdog records it in the state file (`stalledAgents`), adds `STALLED: <id> <N>m` to the status line, and sends one message to the orchestrator: "Bun Warmer notice sent at <HH:MM> local time, ignore if you have since run /bunwarm off or the subagent already finished. A subagent of type <type> with id <id> had shown running but silent for <N> minutes at that time. Look it up by that id in your own Agent list. Suggested, non-destructive: check whether it has produced output or is still running before deciding; do not stop or respawn it on this notice alone." The message is fixed text plus values that cannot carry instructions: the id reduced to letters, digits, `_` and `-` (anything else becomes `_`, at most 40 characters), the type only if it is one of a short allowlist (`general-purpose`, `Explore`, `Plan`, `claude`, `claude-code-guide`, `statusline-setup`) and otherwise `agent`, whole minutes, and the local time. The agent's free-text description comes from spawn metadata and can contain instructions, so it is never put in the message or the status line; the state file keeps only a sanitized form (printable ASCII from a short set, at most 80 characters). A hostile id is reduced to the safe character set but its letters survive (an id of `a1 IGNORE` shows as `a1_IGNORE`), which is why the message tells the orchestrator to look the agent up in its own Agent list rather than trust the text. The message is written to be harmless if it arrives late The flag clears when the agent produces events again or is no longer `running`; a later stall is a new report.

Route for the message: `$.prompt.submit({ text })`. It enters the main conversation as a prompt with origin `{ kind: 'plugin', name: 'bun-warmer' }`, framed to the model as "The bun-warmer plugin sent a message", and it starts a turn of its own once the session is idle. The engine skips the calling plugin's own `prompt.submit` hook for it, so Bun Warmer's guard never sees its own message (and `plugin` is not a human origin anyway). **Accepted residual, not fixed:** the plugin API has no way to withdraw a queued prompt. Immediately before calling `$.prompt.submit` the mod re-checks armed, the session epoch and the main-loop turn count with no await between the check and the call, and the message is worded to be harmless if late. A narrow race remains: if a main turn starts, or `/bunwarm off` or `/clear` runs, after that check and before the engine queues the submit, one stall message can still be delivered after the fact. The late message says to ignore it if the mod was turned off or the agent finished. Turning the mod off (`/bunwarm off`, window expiry, the cap) or a `/clear`/resume cancels the watchdog, and the loop sends nothing more after that.

Busy-loop rule (a mitigation, Confirmed by the tests, not live): the types file offers no call that says whether the main loop is busy and none that withdraws or cancels a submitted prompt (checked: `$.prompt`, `$.turn`, `$.session` have `submit`, `read`, `abort` and the like, nothing for a queue). Option (a), withdraw or query, is not possible. Option (b), "send only when idle", has no direct signal either, so the mod counts main-loop turns itself from `turn.start`, `turn.step` and `turn.complete` (no `agentId`), and submits a stall message only while that count is zero. While a main turn runs, the flagged agent waits with `messageSent: null` in the state file and the message goes out on the first 5-minute pass after the turn completes, if the agent is still flagged and the mod is still on. A stall of a foreground subagent the orchestrator is waiting on therefore shows in the status line and state file but sends no message until that turn ends; a background subagent (the main loop idle) is messaged as before.

Residual, plainly: the mod's own `prompt.submit` hook is skipped for its own submit (the types say "every hook but the calling one"), so it cannot drop a stall message after the fact. The scenario that remains: the mod counts the main loop idle (a turn began in the instant between its check and the submit, or a turn that started before a hot reload has not yet produced a step the mod could see), the message is queued, you run `/bunwarm off`, and the message later starts a turn. That is why the message begins with the time it was sent and says to ignore it if `/bunwarm off` was run or the subagent has finished, names the subagent and the minutes, and recommends nothing destructive. The opposite failure also exists: if a `turn.complete` is never delivered, the mod keeps counting the loop busy and sends no stall message until the session or the turn count resets.

`messageSent` is `null` while the message waits for an idle main loop. If the engine drops it or the call throws, `messageSent` is `false` in the state file, the stall is still recorded and shown, and nothing else is tried.

Not chosen: `$.session.append` adds a user-role row but starts no turn, so an idle orchestrator would not act on it; `$.session.send` needs a recipient address and the types give no address for the main conversation; `$.session.receive` is the hook for inbound deliveries, not a way to send.

## Settings

Every setting and its default. An environment variable beats the `userConfig` value. `userConfig` fields are rows in the Claude Code config menu; for a folder-loaded plugin they are stored in settings under `pluginConfigs` keyed `bun-warmer@inline`.

| Setting | Default | Config route |
|---|---|---|
| Ping interval | 50 minutes (capped at 55) | env `BUN_WARMER_INTERVAL_MIN`, else `userConfig` `intervalMin` |
| Keep-warm window | 90 minutes | env `BUN_WARMER_WINDOW_HOURS` if set (the old name, kept as an override, in hours), else env `BUN_WARMER_WINDOW_MIN`, else `userConfig` `windowMin`, else 90 |
| Hard cap on window extension | 12 hours | env `BUN_WARMER_MAX_HOURS` |
| Minimum context to ping or warn | 50,000 tokens | env `BUN_WARMER_MIN_TOKENS`, else `userConfig` `minTokens` |
| Cold-send guard | `warn` (a note, never a drop) | `userConfig` `guard` (`warn` or `refuse`) |
| Active hours | 06:00 to 23:00 local | env `BUN_WARMER_ACTIVE_START` (6), `BUN_WARMER_ACTIVE_END` (23), `BUN_WARMER_QUIET_HOURS=off` (see Quiet hours) |
| Stall threshold | 20 minutes | env `BUN_WARMER_STALL_MIN` |
| Stall check interval | 5 minutes | env `BUN_WARMER_STALL_CHECK_MIN` |
| Pulse script path | `<plugin folder>/bin/session-pulse.py` | env `BUN_WARMER_PULSE` (tried first) |

Ranges: every numeric setting is checked against a range, and a value outside it (empty, text, `NaN`, `Infinity`, `1e300`, zero, negative, too big) is ignored: the next source or the default applies, and a line naming the variable is added to `configWarnings` in the state file (never the raw value). A value that is valid but clamped, such as an interval from 56 to 240 minutes capped at 55, also adds a fixed-wording line. Window 1 to 720 minutes (`BUN_WARMER_WINDOW_HOURS`: 1/60 to 12 hours), ping interval 5 to 240 minutes (then capped at 55, with a `configWarnings` entry when the cap bites), hard cap `BUN_WARMER_MAX_HOURS` 1 to 48 hours, minimum tokens 0 to 2,000,000, stall threshold 1 to 720 minutes, stall check interval 1 to 60 minutes, active hours whole numbers 0 to 23. The same ranges apply to the `userConfig` values.

Window precedence, spelled out: `BUN_WARMER_WINDOW_HOURS` (if set to a positive number) beats `BUN_WARMER_WINDOW_MIN` (positive number) beats the `windowMin` field beats 90 minutes. A value that is not a number in range counts as not set. Pings never extend the window, and the hard cap on extension is unchanged.

Slash command: `/bunwarm` shows status, `/bunwarm off` stops it for this session, `/bunwarm on` restarts the window.

## State file

`~/.claude/bun-warmer/<file-name>.json`, rewritten on every arm, disarm, ping and activity event. The file is informational: for people and scripts that want to look. Nothing in Claude Code or in the close hook depends on it (the close hook runs at 45 minutes idle and does not read it). It is written as a temporary file beside it and moved into place with `mv`, so a reader never sees half a file.

File name rule (a reader must apply it to a session id): keep the characters `A-Z a-z 0-9 _ -`; replace every other character with `%` plus two uppercase hex digits per UTF-8 byte (`a/b` becomes `a%2Fb`, `a?b` becomes `a%3Fb`, `%` becomes `%25`, `.` becomes `%2E`, `é` becomes `%C3%A9`). Decode by reading the `%XX` bytes as UTF-8. A lone UTF-16 surrogate has no UTF-8 bytes, so it is first replaced by U+FFFD and written as `%EF%BF%BD`; that is the one case where the mapping is not reversible (two ids that differ only in lone surrogates would share a file). Every other id maps to its own file. A UUID session id is unchanged. The temp file is `.<file-name>.json.tmp`.

Staleness: every file carries `writtenAt` (ISO with milliseconds, e.g. `2026-10-14T22:39:00.123-07:00`), `writtenAtEpoch` (seconds) and `writtenAtEpochMs`, the time of that write. A reader compares `writtenAtEpochMs` with the clock and treats a file older than the interval as old, not current.

Write failures: if the write or the `mv` fails, the temp file is removed, the failure is logged, and `<file-name>.error.json` is written beside the state file with `sessionId`, `failedAt`, `failedAtEpoch`, `failedAtEpochMs` and `error`. The previous state file is left as it was (its `writtenAt` shows how old it is). The next successful write deletes the error file; if that deletion itself fails (nonzero exit), the mod logs it, keeps the error file marked for removal and retries on every following write, so a stale error file is not forgotten.

Double failure: if the error file cannot be written either, the mod tries to remove the old state file, so an absent file is what a reader sees instead of a stale one that looks current. If that removal fails too, the old file stays and nothing durable says so; the mod then shows `STATE FILE NOT WRITTEN and the old one could not be removed, so it is stale` in its status line and writes it to the log (neither survives the session). That residual case is real: a reader can only catch it by the age of `writtenAtEpochMs`. The next successful write clears the warning.

```json
{
  "sessionId": "…",
  "writtenAt": "…", "writtenAtEpoch": 0, "writtenAtEpochMs": 0,
  "armed": true,
  "armedAt": "2026-10-14T22:39:00-07:00",        "armedAtEpoch": 1792042740,
  "windowStartAt": "…",                          "windowStartAtEpoch": 0,
  "lastPingAt": "2026-10-14T23:29:00-07:00",     "lastPingAtEpoch": 1792045740,
  "lastActivityAt": "…",                         "lastActivityAtEpoch": 0,
  "expiresAt": "…",                              "expiresAtEpoch": 0,
  "refusals": 0,
  "guardDrops": 0,
  "quietHours": { "enabled": true, "activeStartHour": 6, "activeEndHour": 23 },
  "skippedQuiet": 0,
  "lastSkippedAt": null,                          "lastSkippedAtEpoch": null,
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

Time fields are `null` until they have happened. `skippedSmall` counts pings not sent because the context was under `minTokens` or not yet known; `contextTokens` is that size (`null` when unknown). `configWarnings` lists settings that were ignored for being out of range or unusable (variable name only). `pulse` is the last stall check's view of the transcript pulse (`null` until a check ran with an agent running). `refusals` counts pings that failed or were refused (including a ping that found the cache already gone). `guardDrops` counts prompts dropped by the opt-in refuse guard. `armed` is false after the window expires, `/bunwarm off`, `/clear` or session end, and `note` says which. After `/clear` the old session's file keeps `armed: false`, `note: "cleared"`; the new session writes its own file under its own id.

## Install and switch from cache-tax

Both mods ping, so load only one. How a folder mod is loaded is from reference.md ("Developing one"): `CLAUDE_CODE_PLUGIN_DIRS` names plugin folders (absolute paths), read exactly like `claude --plugin-dir`, taken from the process environment or the `env` block of `~/.claude/settings.json`. `claude plugin disable` and `enable` are Claude Code commands (Confirmed with `claude plugin disable --help`); the installed cache-tax id is `cache-tax@claude-code-mods`, user scope (Confirmed with `claude plugin list`). A marketplace install was not confirmed for a single-plugin folder, so it is not documented here.

Steps:

1. Turn cache-tax off: `claude plugin disable cache-tax@claude-code-mods`
2. Load Bun Warmer from its folder. To try it for one session first: `claude --plugin-dir /path/to/bun-warmer`. To load it every session, add this to `~/.claude/settings.json` (merge into the existing `env` block if there is one):

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/bun-warmer" } }
```

3. Start a new Claude Code session (a running session does not pick up a settings change).
4. Confirm it is running: type `/bunwarm`. It answers `bun-warmer on, ... left`. Also check that `~/.claude/bun-warmer/<session-id>.json` exists.

To undo: remove the `CLAUDE_CODE_PLUGIN_DIRS` line from `~/.claude/settings.json` (or stop passing `--plugin-dir`), run `claude plugin enable cache-tax@claude-code-mods`, and start a new session. `/bunwarm off` stops Bun Warmer for the current session only.

## Not built

A close-the-session trigger. The `$.session` API in this build has no close or exit call, so there is nothing to call. The close is done outside this mod, by the close hook at 45 minutes idle.

## Unproven

Live test, 2026-10-14 (headless `claude -p --model haiku --plugin-dir`, STALL_MIN=1, STALL_CHECK_MIN=1, one background haiku subagent running a 240-second Python sleep): the state file listed the agent in `stalledAgents` with `messageSent: true` (flagged 23:02:02), and the orchestrator's transcript showed the exact Bun Warmer message and it acted on it. A first attempt failed only because a user hook blocks a bare `sleep` command. The installed cache-tax mod was not excluded from that run (not checked whether it loaded).

Not proven by the unit tests: that a real orchestrator reads the message while it is blocked waiting on a subagent. `$.prompt.submit` is documented as a turn of its own "once the session is idle", so while the main loop is mid-turn the message waits until that turn ends. Event coverage for a subagent is turn.step, turn.complete and tool.call; a subagent that streams for a long time inside one model step would look quiet.

## Development

```
claude plugin validate .
claude plugin test .
python3 -m unittest discover -s tests/pulse
```

The suites build every time from local calendar fields, so run them under more than one zone, for example `TZ=America/Los_Angeles claude plugin test .` and `TZ=UTC claude plugin test .`.
