# Bun Warmer

A Claude Code mod that keeps the prompt cache warm during breaks, so the next message reads the cache instead of re-writing it.

Inspired by cache-tax by Karan Bansal (MIT, https://github.com/karanb192/cache-tax). Bun Warmer is written from scratch; none of his code is copied.

Requires Claude Code 2.1.300 or newer (function hooks, early-access API).

## What it does

- Arms itself when a session starts. After the interval of quiet (default 50 minutes) it sends a tool-less ping with `$.model.fork`, which reads the cache and refreshes its one-hour lifetime. Pings continue for the window (default 3 hours) after your last typed prompt.
- A cold cache (60 minutes since any activity) is never pinged, because that would pay the full rewrite.
- Subagent activity counts as main-session activity. Any turn step or turn completion carrying an `agentId` updates `lastActivityAt`. At window expiry the window is extended instead of closed while turns arrived within the last interval or a subagent has status `running`. `pending` and `waiting` agents (for example one waiting on a plan approval) never extend it, because an abandoned one could wait forever. Extensions have a hard cap: the window can never reach past `BUN_WARMER_MAX_HOURS` (default 12) after the start of the current window (session start, a typed prompt, or `/bunwarm on`). At the cap the mod disarms with `note: "maximum of 12h00m reached"`, whatever is still running.
- The cold-send guard only ever looks at prompts a person typed (origin `composer` or `bridge`). Every other origin passes through untouched: `sdk`, `task-notification`, `scheduled-trigger`, `peer`, `peer-send-message`, `projects-relay`, `channel`, `coordinator`, `observer`, `observer-activity`, `auto-continuation`, `unclassified`, `slack-ping`, `plugin`. The default guard mode is `warn` (a note with the token count, never a drop). `refuse` is opt-in and drops only a human first send once.
- `/clear` ends the session without a `session.start`. Bun Warmer resets everything about the old session (context size, activity times, ping record, counters, stalled agents), leaves the old session's state file as `armed: false` with `note: "cleared"`, and takes the new session id from the next event it sees. It stays disarmed until you type a prompt. The same reset runs on resume and whenever an event arrives under a session id different from the one it holds.
- Compaction (`session.compact`, main conversation only, not a skip) clears the remembered context size and the guard's acknowledgement, so the cold-send guard cannot act on the pre-compaction count. The size is set again only by the next response (`turn.complete`).
- A ping's own model call is never session activity, and a subagent's work during a ping always is. The API puts no marker on a fork's events, so while a ping is in flight an event with no `agentId` is taken for the ping's and ignored; an event carrying the `agentId` of a subagent that `$.agent.list()` names (a real subagent turn step, turn completion or tool completion) moves `lastActivityAt` as usual. An `agentId` that no list names (an engine fork) is ignored. The residual: real main-conversation activity that has no `agentId` and lands inside the few seconds of a ping is also ignored; the next event after the ping counts. `lastPingAt` is a separate field. A reader that decides when to close the session from `lastActivityAt` is not kept alive by the pings.
- Each session has a generation number that `/clear`, resume and session end bump. A ping that was out when that happened is discarded when its answer arrives: it does not write a result, a refusal count or a state file for the new session, and the ping-in-flight flag is cleared at the reset so the new session's first ping is never skipped. A timer that fires while a ping is still out reschedules itself instead of dropping the schedule. A reader that decides when to close the session from `lastActivityAt` is not kept alive by the pings.
- A ping that fails, is refused, or finds the cache already gone is recorded as failed in the state file and shown in the status line. It is never reported as success.
- The mod does not know model prices, so the guard note shows the token count that would be re-written, not a dollar figure.

Timer callbacks (the ping timer and the watchdog timer) have rejection handlers that log `bun-warmer: tick failed (...)` or `stall check failed (...)` through a logger that never throws, so a clock or UI call that fails during teardown cannot become an unhandled rejection. No automated test covers this: the test kit lets one hook answer `clock.now` and `mock.clock` holds it.

## Stall watchdog

While a session has subagents, a second timer (separate from the ping) checks `$.agent.list()` every `BUN_WARMER_STALL_CHECK_MIN` minutes (default 5). The call is local and costs no tokens. A subagent whose status is `running` and that has produced no event (turn step, turn completion, tool call start or finish) and has no tool call in flight for `BUN_WARMER_STALL_MIN` minutes (default 20) is stalled. A tool call that has started and not finished counts as active for as long as it runs, however long, and its completion restarts the clock; a model step that streams for a long time without a tool call can still look quiet. An agent never seen producing an event is timed from the first check that saw it running. The watchdog never stops or kills anything. It runs only while the mod is armed: `/bunwarm off`, window expiry, `/clear` and session end all stop its timer (and clear its stalled list), and `/bunwarm on` or a typed prompt starts it again.

Each stall is reported once. The watchdog records it in the state file (`stalledAgents`), adds `STALLED: <description> <N>m` to the status line, and sends one message to the orchestrator: "Bun Warmer: subagent <description> (<id>) has shown running but silent for <N> minutes. Decide: wait, stop it, or respawn it." The flag clears when the agent produces events again or is no longer `running`; a later stall is a new report.

Route for the message: `$.prompt.submit({ text })`. It enters the main conversation as a prompt with origin `{ kind: 'plugin', name: 'bun-warmer' }`, framed to the model as "The bun-warmer plugin sent a message", and it starts a turn of its own once the session is idle. The engine skips the calling plugin's own `prompt.submit` hook for it, so Bun Warmer's guard never sees its own message (and `plugin` is not a human origin anyway). Turning the mod off (`/bunwarm off`, window expiry, the cap) or a `/clear`/resume cancels the watchdog and marks every message prepared before it as void: the loop sends nothing more, and Bun Warmer's `prompt.submit` hook drops any of its own stall messages whose preparation is void. `$.prompt.submit` queues the prompt until the session is idle and the hooks run as it starts its turn, so that hook is the point where a message queued before `/bunwarm off` can still be stopped. Residual, not checked live: the types file offers no call to cancel a submitted prompt, and the note above about the engine skipping the calling plugin's own hook is not confirmed by the types (they say only "every hook but the calling one"); if the engine does skip it, a message submitted just before `/bunwarm off` can still enter the conversation once the session goes idle. The window is as small as it can be: the check runs immediately before each send, and no message is sent after a disarm.

If the engine drops it or the call throws, `messageSent` is `false` in the state file, the stall is still recorded and shown, and nothing else is tried.

Not chosen: `$.session.append` adds a user-role row but starts no turn, so an idle orchestrator would not act on it; `$.session.send` needs a recipient address and the types give no address for the main conversation; `$.session.receive` is the hook for inbound deliveries, not a way to send.

## Settings

| Setting | Default | Config route |
|---|---|---|
| Ping interval | 50 minutes (capped at 55) | env `BUN_WARMER_INTERVAL_MIN`, else `userConfig` field `intervalMin` |
| Window | 3 hours | env `BUN_WARMER_WINDOW_HOURS`, else `userConfig` field `windowHours` |
| Guard | `warn` | `userConfig` field `guard` (`warn` or `refuse`) |
| Stall threshold | 20 minutes | env `BUN_WARMER_STALL_MIN` |
| Stall check interval | 5 minutes | env `BUN_WARMER_STALL_CHECK_MIN` |
| Hard cap on window extension | 12 hours | env `BUN_WARMER_MAX_HOURS` |

An environment variable beats the `userConfig` value. `userConfig` fields are rows in the Claude Code config menu; for a folder-loaded plugin they are stored in settings under `pluginConfigs` keyed `bun-warmer@inline`.

Slash command: `/bunwarm` shows status, `/bunwarm off` stops it for this session, `/bunwarm on` restarts the window.

## State file

`~/.claude/bun-warmer/<file-name>.json`, rewritten on every arm, disarm, ping and activity event. It is written as a temporary file beside it and moved into place with `mv`, so a reader never sees half a file.

File name rule (a reader such as `close-on-stop.sh` must apply it to a session id): keep the characters `A-Z a-z 0-9 _ -`; replace every other character with `%` plus two uppercase hex digits per UTF-8 byte (`a/b` becomes `a%2Fb`, `a?b` becomes `a%3Fb`, `%` becomes `%25`, `.` becomes `%2E`, `é` becomes `%C3%A9`). Decode by reading the `%XX` bytes as UTF-8. A lone UTF-16 surrogate has no UTF-8 bytes, so it is first replaced by U+FFFD and written as `%EF%BF%BD`; that is the one case where the mapping is not reversible (two ids that differ only in lone surrogates would share a file). Every other id maps to its own file. A UUID session id is unchanged. The temp file is `.<file-name>.json.tmp`.

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
  "lastPing": { "at": "…", "atEpoch": 0, "ok": true, "reason": null, "cacheReadTokens": 0, "cacheWriteTokens": 0 },
  "intervalMin": 50,
  "windowHours": 3,
  "maxHours": 12,
  "note": null,
  "stallMin": 20,
  "stallCheckMin": 5,
  "stalledAgents": [
    { "id": "…", "description": "…", "type": "general-purpose", "minutesSilent": 22, "firstFlaggedAt": "…", "firstFlaggedAtEpoch": 0, "messageSent": true }
  ]
}
```

Time fields are `null` until they have happened. `refusals` counts pings that failed or were refused (including a ping that found the cache already gone). `guardDrops` counts prompts dropped by the opt-in refuse guard. `armed` is false after the window expires, `/bunwarm off`, `/clear` or session end, and `note` says which. After `/clear` the old session's file keeps `armed: false`, `note: "cleared"`; the new session writes its own file under its own id.

## Install

Try it for one session:

```
claude --plugin-dir /Users/Eugenia/Developer/bun-warmer
```

Load it permanently: set `CLAUDE_CODE_PLUGIN_DIRS` to the folder in the `env` block of `~/.claude/settings.json`. It is read exactly like `--plugin-dir` (reference.md, "Developing one"). A marketplace install was not confirmed for a single-plugin folder, so it is not documented here.

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/Users/Eugenia/Developer/bun-warmer" } }
```

## Switch from cache-tax

Both mods would ping, so load only one.

1. `claude plugin disable cache-tax@claude-code-mods`
2. Add the `CLAUDE_CODE_PLUGIN_DIRS` line above to `~/.claude/settings.json`.
3. Start a new session and run `/bunwarm`. Check `~/.claude/bun-warmer/<session-id>.json` exists.

To go back: remove the env line and `claude plugin enable cache-tax@claude-code-mods`.

## Not built

A close-the-session trigger shortly before expiry. The `$.session` API in this build has no close or exit call, so there is nothing to call. The state file carries `expiresAt` for an outside close hook instead.

## Unproven

Live test, 2026-10-14 (headless `claude -p --model haiku --plugin-dir`, STALL_MIN=1, STALL_CHECK_MIN=1, one background haiku subagent running a 240-second Python sleep): the state file listed the agent in `stalledAgents` with `messageSent: true` (flagged 23:02:02), and the orchestrator's transcript showed the exact Bun Warmer message and it acted on it. A first attempt failed only because a user hook blocks a bare `sleep` command. The installed cache-tax mod was not excluded from that run (not checked whether it loaded).

Not proven by the unit tests: that a real orchestrator reads the message while it is blocked waiting on a subagent. `$.prompt.submit` is documented as a turn of its own "once the session is idle", so while the main loop is mid-turn the message waits until that turn ends. Event coverage for a subagent is turn.step, turn.complete and tool.call; a subagent that streams for a long time inside one model step would look quiet.

## Development

```
claude plugin validate .
claude plugin test .
```
