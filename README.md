# Bun Warmer

A Claude Code mod that keeps the prompt cache warm during breaks, so the next message reads the cache instead of re-writing it.

Inspired by cache-tax by Karan Bansal (MIT, https://github.com/karanb192/cache-tax). Bun Warmer is written from scratch; none of his code is copied.

Requires Claude Code 2.1.300 or newer (function hooks, early-access API).

## What it does

- Arms itself when a session starts. After the interval of quiet (default 50 minutes) it sends a tool-less ping with `$.model.fork`, which reads the cache and refreshes its one-hour lifetime. Pings continue for the window (default 3 hours) after your last typed prompt.
- A cold cache (60 minutes since any activity) is never pinged, because that would pay the full rewrite.
- Subagent activity counts as main-session activity. Any turn step or turn completion carrying an `agentId` updates `lastActivityAt`. At window expiry the window is extended instead of closed while turns arrived within the last interval or a subagent is running, pending or waiting.
- The cold-send guard only ever looks at prompts a person typed (origin `composer` or `bridge`). Every other origin passes through untouched: `sdk`, `task-notification`, `scheduled-trigger`, `peer`, `peer-send-message`, `projects-relay`, `channel`, `coordinator`, `observer`, `observer-activity`, `auto-continuation`, `unclassified`, `slack-ping`, `plugin`. The default guard mode is `warn` (a note with the token count, never a drop). `refuse` is opt-in and drops only a human first send once.
- A ping that fails, is refused, or finds the cache already gone is recorded as failed in the state file and shown in the status line. It is never reported as success.
- The mod does not know model prices, so the guard note shows the token count that would be re-written, not a dollar figure.

## Settings

| Setting | Default | Config route |
|---|---|---|
| Ping interval | 50 minutes (capped at 55) | env `BUN_WARMER_INTERVAL_MIN`, else `userConfig` field `intervalMin` |
| Window | 3 hours | env `BUN_WARMER_WINDOW_HOURS`, else `userConfig` field `windowHours` |
| Guard | `warn` | `userConfig` field `guard` (`warn` or `refuse`) |

An environment variable beats the `userConfig` value. `userConfig` fields are rows in the Claude Code config menu; for a folder-loaded plugin they are stored in settings under `pluginConfigs` keyed `bun-warmer@inline`.

Slash command: `/bunwarm` shows status, `/bunwarm off` stops it for this session, `/bunwarm on` restarts the window.

## State file

`~/.claude/bun-warmer/<session-id>.json`, rewritten on every arm, disarm, ping and activity event. It is written as a temporary file beside it and moved into place with `mv`, so a reader never sees half a file.

```json
{
  "sessionId": "…",
  "armed": true,
  "armedAt": "2026-10-14T22:39:00-07:00",        "armedAtEpoch": 1792042740,
  "lastPingAt": "2026-10-14T23:29:00-07:00",     "lastPingAtEpoch": 1792045740,
  "lastActivityAt": "…",                         "lastActivityAtEpoch": 0,
  "expiresAt": "…",                              "expiresAtEpoch": 0,
  "refusals": 0,
  "guardDrops": 0,
  "lastPing": { "at": "…", "atEpoch": 0, "ok": true, "reason": null, "cacheReadTokens": 0, "cacheWriteTokens": 0 },
  "intervalMin": 50,
  "windowHours": 3,
  "note": null
}
```

Time fields are `null` until they have happened. `refusals` counts pings that failed or were refused (including a ping that found the cache already gone). `guardDrops` counts prompts dropped by the opt-in refuse guard. `armed` is false after the window expires, `/bunwarm off`, `/clear` or session end, and `note` says which.

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

## Development

```
claude plugin validate .
claude plugin test .
```
