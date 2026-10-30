# Bun Warmer

Bun Warmer is a mod for Claude Code users who take breaks during long sessions. Claude Code caches your conversation so the next message does not re-process it. How long that cache lasts depends on how you pay: on a Claude subscription within your plan's included usage the main conversation's cache lasts **60 minutes**; with an API key, a cloud provider (Bedrock, Vertex, Foundry), or a subscription drawing on usage credits it lasts **5 minutes**, unless you chose one hour yourself ([Anthropic: Which TTL each request gets](https://code.claude.com/docs/en/prompt-caching#which-ttl-each-request-gets)). After a break longer than the cache, your next message re-writes the whole context at the cache-write rate, which is slow and costly.

When your main cache lasts an hour, Bun Warmer sends a small ping after 50 minutes of quiet so the cache stays warm, for up to 3 hours after your last prompt. When it lasts 5 minutes, or Bun Warmer cannot tell, it sends no pings at all, because a ping every few minutes would cost more than it saves; the state file and a one-time note under the prompt say why. It also flags subagents that go silent.

## What this installs

- One hooks module, `hooks/register.ts`, which Claude Code loads as a mod when you point it at this folder. Nothing is installed system-wide and no background process runs outside Claude Code.
- One slash command, `/bunwarm` (status, on, off).
- One state file per session in `~/.claude/bun-warmer/<session-id>.json`, rewritten as the session runs. At each session start, Bun Warmer removes state files that say `armed: false` and are older than 30 days, plus leftover temp files older than a day (see [Cleanup](#cleanup)). You can delete any of them yourself at any time.
- An optional status line script, `bin/statusline.py` (standard library only). It does nothing until you add it to your status line (see [Status line](#status-line)).
- A Python script, `bin/session-pulse.py` (standard library only), which the mod runs with `python3` while subagents are running, to read the session's local transcript files and check they are still being written.
- Pings. Each ping is a real, tool-less model call over your conversation (`$.model.fork`). It spends tokens: on a subscription it counts against your usage, on an API key it is billed. Bun Warmer pings only when your main cache is known to last an hour.
- Nothing else sends a model request. A stalled subagent is flagged in the state file and under the prompt only; the optional stall prompt (`BUN_WARMER_STALL_PROMPT=on`) is off by default because it starts a model turn.

## Which cache length you have

Bun Warmer reads the same inputs Claude Code uses for the main conversation, in Claude Code's order, when a session starts (Claude Code also has a subagent-only step, a `cacheTtl` in a subagent's frontmatter, which does not apply to the main conversation and is not read):

1. `FORCE_PROMPT_CACHING_5M=1`: 5 minutes, no pings.
2. `CLAUDE_CODE_PROMPT_CACHE_TTL` (`5m` or `1h`).
3. The `promptCacheTtl` setting (`5m` or `1h`).
4. `ENABLE_PROMPT_CACHING_1H=1`: one hour.
5. Otherwise, your login: a Claude subscription login means one hour; an API key means 5 minutes; no first-party login (a cloud provider or a gateway) means unknown, and unknown means no pings.

`DISABLE_PROMPT_CACHING=1` means there is no cache, so no pings. Any of the per-model disables (`DISABLE_PROMPT_CACHING_HAIKU`, `_SONNET`, `_OPUS`, `_FABLE`) set to `1` also means no pings, because Bun Warmer cannot tell whether it covers your session's model. Any value other than `5m` or `1h` is ignored, as Claude Code ignores it. The result is in the state file as `cacheTtl` (`1h`, `5m`, `unknown` or `off`) with `cacheTtlReason`.

On a subscription with no TTL setting, a login alone does not prove the hour, because a subscription past its plan limit draws on usage credits and gets 5 minutes. So before each ping Bun Warmer reads the plan's rate-limit windows (`five_hour`, `seven_day`, the ones Claude Code reports after each response) and pings only when at least one was read and all are under 100%. No reading yet, a reading that fails, or a window at 100% means no ping; pings resume once a later reading is under the limit. If a ping still finds the cache gone, Bun Warmer stops pinging for the rest of the session. An explicit `1h` (variable or setting) holds on usage credits too, so it needs no reading.

- **Claude subscription (Pro, Max, Team, Enterprise) within plan usage:** works as is.
- **API key, usage credits, or a cloud provider:** Bun Warmer does nothing unless you choose the one-hour cache yourself. Choose the one-hour cache in `~/.claude/settings.json` in one of two ways; this needs Claude Code 2.1.242 or later. The variable goes inside the `env` block, the setting goes at the top level, never inside `env`:

```json
{ "env": { "CLAUDE_CODE_PROMPT_CACHE_TTL": "1h" } }
```

```json
{ "promptCacheTtl": "1h" }
```

 One-hour cache writes cost more than five-minute ones (on the API, 2x the input price against 1.25x), so decide that on its own merits first. To check which TTL your writes use, run `claude -p "hello" --output-format json` and look at `usage.cache_creation`: one-hour writes are under `ephemeral_1h_input_tokens`.

Inspired by [cache-tax](https://github.com/karanb192/cache-tax) by Karan Bansal (MIT). Bun Warmer is written from scratch; none of its code is copied.

## Requirements

- Claude Code with the function-hook mod (plugin) API, which is early access. The plugin does not declare a minimum version; it has been tested on Claude Code 2.1.314. Check yours with `claude --version`. If your version does not have the mod API, the mod does not load and `/bunwarm` does not respond (step 5 below); update Claude Code and try again.
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

### A settings example

Every setting is an environment variable, so it goes in the `env` block of `~/.claude/settings.json` beside `CLAUDE_CODE_PLUGIN_DIRS`. Values are strings. Leave out any line you do not need; each default is in [Configuration](#configuration).

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/bun-warmer",
    "BUN_WARMER_WINDOW_MIN": "180",
    "BUN_WARMER_INTERVAL_MIN": "50",
    "BUN_WARMER_QUIET_HOURS": "on",
    "BUN_WARMER_ACTIVE_START": "6",
    "BUN_WARMER_ACTIVE_END": "23",
    "BUN_WARMER_STALL_MIN": "20",
    "BUN_WARMER_STALL_CHECK_MIN": "5",
    "BUN_WARMER_STALL_PROMPT": "off",
    "BUN_WARMER_KEEP_DAYS": "30"
  }
}
```

Only on an API key, usage credits or a cloud provider, and only if you want the one-hour cache (it changes what every request costs, not just Bun Warmer's): add `"CLAUDE_CODE_PROMPT_CACHE_TTL": "1h"` inside this same `env` block.

### Updating

```
cd /path/to/bun-warmer
git pull
```

Then start a new Claude Code session. A running session keeps the version it loaded.

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

### Status line

Bun Warmer keeps a one-line status in the state file (`statusText`, with `statusState` and `nextPingAt`). Claude Code does not show that line by itself: under the prompt you only see Bun Warmer when something needs your attention (it is off and why, a failed ping, a stalled subagent, a state file it could not write). To see the routine line all the time, turn on the ready-made script `bin/statusline.py` as your [status line](https://code.claude.com/docs/en/statusline). It reads the `session_id` Claude Code passes it, reads that session's state file, and prints one line with the countdowns worked out as it runs. It prints nothing when the mod is off for the session.

If you have no status line yet, add this to `~/.claude/settings.json` (top level, not inside `env`):

```json
{
  "statusLine": { "type": "command", "command": "python3 /path/to/bun-warmer/bin/statusline.py" }
}
```

If you already have one, keep it and add Bun Warmer after it. When your status line is a script that reads its input into a variable (for example `input=$(cat)`), add one line that passes the same input on:

```sh
printf '%s' "$input" | python3 /path/to/bun-warmer/bin/statusline.py
```

When it is a single command, wrap it so both get the same input, and replace `<your current command>` with what your `command` says today:

```json
{
  "statusLine": {
    "type": "command",
    "command": "input=$(cat); printf '%s  %s' \"$(printf '%s' \"$input\" | <your current command>)\" \"$(printf '%s' \"$input\" | python3 /path/to/bun-warmer/bin/statusline.py)\""
  }
}
```

The status line updates as Claude Code refreshes it. The line looks like this:

```
bun-warmer · idle · 1h30m left · waiting for the first turn
bun-warmer · warm · 1h25m left · ping in 50m
bun-warmer · cold · 20m left · cache cold, waiting for activity
```

- `idle` means no turn has happened yet.
- `warm` means there was activity or a successful ping in the last 60 minutes.
- `cold` means 60 minutes have passed with no activity or successful ping.

When your main cache is not known to last an hour, the line reads `bun-warmer off: main cache lasts 5 minutes (<why>), so a ping cannot keep it warm; not pinging` or `bun-warmer off: main cache length unknown (<why>), not pinging; ...`, and no ping goes out. The last part can also read `quiet hours, pings resume 06:00`, `context under 50,000 tokens, not pinging`, or `context size unknown, not pinging`. A failed ping adds `last ping FAILED: <reason>`, and a silent subagent adds `STALLED: <id> <N>m`. When the mod is off, the line reads `bun-warmer off: <reason>`.

## Configuration

An environment variable beats the matching config menu value. The config menu fields (`intervalMin`, `windowMin`, `minTokens`, `guard`) appear in the Claude Code plugin config menu; for a folder-loaded plugin they are stored in settings under `pluginConfigs`, keyed `bun-warmer@inline`.

| Setting | Default | How to set it |
|---|---|---|
| Ping interval | 50 minutes, capped at 55 | env `BUN_WARMER_INTERVAL_MIN`, or config `intervalMin` |
| Keep-warm window | 180 minutes (3 hours) | env `BUN_WARMER_WINDOW_HOURS` (hours), else env `BUN_WARMER_WINDOW_MIN`, else config `windowMin` |
| Hard cap on window extensions | 12 hours | env `BUN_WARMER_MAX_HOURS` |
| Minimum context to ping or warn | 50,000 tokens | env `BUN_WARMER_MIN_TOKENS`, or config `minTokens` |
| Cold-send guard (what happens when you type into a cold cache) | `warn` | config `guard`: `warn` or `refuse` |
| First active hour | 6 | env `BUN_WARMER_ACTIVE_START` (0-23) |
| First quiet hour | 23 | env `BUN_WARMER_ACTIVE_END` (0-23, exclusive) |
| Quiet hours | on | env `BUN_WARMER_QUIET_HOURS=off` pings around the clock, still inside the window |
| Stall threshold | 20 minutes | env `BUN_WARMER_STALL_MIN` |
| Stall check interval | 5 minutes | env `BUN_WARMER_STALL_CHECK_MIN` |
| Stall prompt to the main conversation | off | env `BUN_WARMER_STALL_PROMPT=on` (starts a model turn per stall) |
| Days to keep disarmed state files | 30 | env `BUN_WARMER_KEEP_DAYS` (0 to 3650; 0 never deletes) |
| Pulse script path | `<plugin folder>/bin/session-pulse.py` | env `BUN_WARMER_PULSE` (absolute path ending in `.py`) |

Allowed ranges: window 1 to 720 minutes (`BUN_WARMER_WINDOW_HOURS` 1/60 to 12), ping interval 5 to 240 minutes (then capped at 55), hard cap 1 to 48 hours, minimum tokens 0 to 2,000,000, stall threshold 1 to 720 minutes, stall check interval 1 to 60 minutes, active hours whole numbers 0 to 23. A value outside its range, or one that is not a number, is ignored and the next source or the default applies. The variable's name (never its value) is added to `configWarnings` in the state file. A value that is clamped, such as an interval above 55, also adds a line there.

Active hours: a start greater than the end wraps midnight (22 and 6 means active from 22:00 to 05:59). A start equal to the end means no restriction.

## How it works

### Pings

After the ping interval passes with no activity, Bun Warmer sends a short, tool-less ping through `$.model.fork`. The ping reads the cache, which resets its one-hour lifetime. Pings go out only when the main cache is known to last an hour (see [Which cache length you have](#which-cache-length-you-have)). Pings continue for the window after your last typed prompt.

Bun Warmer never pings:

- a session whose main cache lasts 5 minutes, has unknown length, or is turned off;
- a cache that is already cold (60 minutes since any activity), because the ping would pay the full re-write;
- a session whose context is under the minimum token count, or whose size is not yet known (the size comes from `$.session.usage()` after each response);
- during quiet hours (06:00 to 23:00 local time is active by default).

A ping that fails, is refused, or finds the cache already gone is recorded as failed in the state file and the status line. It is never reported as a success. A ping's own model call does not count as activity, so pings never extend the window.

### Subagents and the window

Subagent turns count as activity. When the window ends while a subagent is still `running`, or turns arrived within the last interval, the window is extended instead of closed. Agents with status `pending` or `waiting` do not extend it, because an abandoned one could wait forever. Extensions stop at the hard cap (default 12 hours after the window started); at the cap Bun Warmer turns itself off.

### Cold-send guard

The guard runs only for a one-hour cache. The cache counts as warm when there was activity or a successful ping within the last 60 minutes; a failed ping does not count. When you type a prompt into a session whose cache has gone cold, the guard notes how many tokens the send will re-write. In the default `warn` mode it only logs that note. In `refuse` mode it drops your first send once with that note; send again to go ahead. It drops only once per cold period: after the next activity or successful ping, a later cold period is guarded again. The guard only looks at prompts a person typed (origins `composer` and `bridge`). Subagent returns, task notifications, scheduled prompts, SDK and plugin messages always pass through. Bun Warmer does not know model prices, so it shows tokens, not dollars.

### Quiet hours

Quiet hours use the local time of the machine Claude Code runs on, including daylight saving time. A ping that comes due during quiet hours is skipped and counted in `skippedQuiet`; it is not a failure. In practice the cache goes cold overnight, and the first prompt you type in the morning pays one re-write. Quiet hours are an extra limit on top of the window, never a replacement: an idle session started at 07:00 pings at 07:50 and stops when its window ends at 08:30.

### `/clear`, resume and compaction

`/clear` and an in-process resume both reset everything Bun Warmer knows about the old session, and a ping that was in flight when that happened is discarded. They differ in what comes next:

- `/clear` leaves the old session's state file with `armed: false` and `note: "cleared"`. The mod stays off until you type a prompt, which arms a new window under the new session id.
- An in-process `/resume` (typed inside a running Claude Code) does not fire the plugin's `session.start`, because that hook fires once per process. The old state file is left with `armed: false`, and the mod stays off until you type a prompt, which arms a new window under the resumed session id.
- Starting a new process with `claude --resume` (or `claude --continue`) does fire `session.start`, so the mod arms right away, without waiting for a prompt. The old session's state file is left with `armed: false` and `note: "session ended"`.

Compaction clears the remembered context size until the next response, so the guard never acts on the old count.

### Stall watchdog

A stall is always recorded in the state file and shown under the prompt; a prompt to the main conversation is sent only with `BUN_WARMER_STALL_PROMPT=on`, because that prompt starts a model turn and uses tokens.

While a session has subagents, a second timer checks `$.agent.list()` every 5 minutes. This call is local and costs no tokens. A `running` subagent that has produced no events and has no tool call in flight for 20 minutes is flagged as stalled. A tool call that is still running counts as activity for as long as it runs.

The transcript pulse is a second signal. On each check that finds at least one subagent with status `running`, Bun Warmer runs `python3 <plugin folder>/bin/session-pulse.py <session-id>` (no shell, 10-second timeout). The script reads the tail of the session's transcript files and reports how long each subagent's transcript has been idle. A subagent is flagged only when both the events and the transcript say it has been quiet longer than the threshold. If the pulse is not available, events decide alone and the state file records why. `script-missing` is recorded only after such a check, so it does not appear while no subagent is running. See [`bin/README-session-pulse.md`](bin/README-session-pulse.md) for the script's output.

Each stall is reported once. Bun Warmer adds it to the state file and the status line. With `BUN_WARMER_STALL_PROMPT=on` it also sends one message to the main conversation through `$.prompt.submit`; that starts a model turn, which uses tokens (counted against a subscription, billed on an API key). The message is fixed text plus a sanitized agent id, an allowlisted agent type, the minutes silent and the local time. It tells the model to check the agent in its own Agent list and not to stop or respawn it on this notice alone. The agent's free-text description is never put in the message, because it can contain instructions. Pulse output is treated as untrusted. Its string ids are used only to match the agent ids the engine reports and are never shown; its numbers and booleans drive the stall decision.

The message is sent only while the main conversation is idle. While a main turn is running, the message waits until that turn ends. The watchdog never stops or kills anything.

After the machine sleeps, the next stall check runs late. When the gap since the previous check is more than two check intervals, Bun Warmer takes it for a sleep and restarts every subagent's silence clock from that moment (counted in `wakes`), so time spent asleep never counts as silence. A subagent still silent a full threshold after waking is flagged as usual.

### Cleanup

Nothing else removes state files, so at each session start Bun Warmer tidies `~/.claude/bun-warmer/`, in the background, without holding the session up. It removes only:

- state files (`*.json`, not `*.error.json`) older than `BUN_WARMER_KEEP_DAYS` (default 30 days) whose content says `armed: false`, which means the window ended, `/bunwarm off`, `/clear` or session end;
- leftover temp files (`.*.json.tmp`) older than a day.

It never removes the current session's file, a file it cannot read or parse, a file that does not say `armed: false`, a directory or a link, and at most 500 files per session start. `BUN_WARMER_KEEP_DAYS=0` turns cleanup off. Age is the file's modification time.

## What it saves

Prices below are Anthropic's API list prices per million tokens (MTok) from the [pricing page](https://platform.claude.com/docs/en/about-claude/pricing), read in October 2026. On a Claude subscription you are not billed per token, but the same re-write counts against your usage. Each number is marked **measured** (read from a state file field) or **calculated** (the arithmetic is shown).

### One break, worked through

A Claude Opus 5.5 session holds 174,324 tokens of context (**measured**: the median `lastPing.cacheReadTokens` in the author's state files, below). You step away for 2 hours.

Rates for Claude Opus 5.5 (list price): a 1-hour cache write is $8 / MTok, a cache read is $0.20 / MTok.

- Without Bun Warmer, a one-hour cache goes cold at 60 minutes. Your next prompt re-writes the whole context: 174,324 × $8 / 1,000,000 = **$1.39** (calculated).
- With Bun Warmer, it pings at 50 and 100 minutes. Each ping reads the cache: 174,324 × $0.20 / 1,000,000 = **$0.035** (calculated, cache read only). Your prompt at 120 minutes reads a warm cache for another $0.035. Total: 3 × $0.035 = **$0.10** (calculated, cache reads only).
- Saved on this break: $1.39 − $0.10 = **$1.29** (calculated).

What these figures leave out: each ping also bills its own prompt (a few input tokens), its reply (the mod asks for one word but sets no cap on output), and any small cache write. In the author's 35 priced pings below, those extras came to $0.069 of cache writes plus $0.0045 of input and output, $0.0735 in all, about $0.002 a ping (calculated from the table). Your own reply after the break is billed as usual and is not counted here either.

On Claude Opus 5.5 a re-write costs 40 times a read ($8 / $0.20 = 40, calculated), so one avoided re-write pays for 40 pings. If you never come back, the pings are spent for nothing. With the default settings (a ping every 50 minutes, a 180-minute window) that is at most 3 pings, at 50, 100 and 150 minutes: 3 × $0.035 = $0.10 in this example (calculated).

### The author's own state files

885 state files, 15 to 26 October 2026, mostly Claude Opus 5.5 and Claude Sonnet 5.5 sessions. A state file keeps only the last ping of its session, so these counts are a floor, not every ping sent.

| What | Value | Grade |
|---|---|---|
| Sessions with a recorded last ping | 43 | measured: `lastPing` present |
| Of those, pings that found the cache warm | 43 | measured: `lastPing.ok` is `true` |
| Failed or refused pings, all sessions | 0 | measured: sum of `refusals` |
| Pings skipped for quiet hours | 34 | measured: sum of `skippedQuiet` |
| Context kept warm per ping | 65,156 to 548,659 tokens, median 174,324 | measured: `lastPing.cacheReadTokens` |
| Cost of the 35 last pings that name a model | $1.26 | calculated, below |
| Re-writes the last pings may have avoided | up to 9 | calculated upper bound, see the note below |

How the $1.26 is calculated, from `lastPing.model`, `lastPing.cacheReadTokens`, `lastPing.cacheWriteTokens` and `lastPing.costUsd`:

- 28 Claude Opus 5.5 pings: 5,396,457 tokens read × $0.20 + 7,330 tokens written × $8, per million = $1.079 + $0.059.
- 7 Claude Sonnet 5.5 pings: 1,043,409 tokens read × $0.10 + 2,392 tokens written × $4, per million = $0.104 + $0.010.
- The pings' own input and output tokens are not stored apart, but `lastPing.costUsd` includes them. The sum of `costUsd` minus its cache read and write share, at the rates it was priced with, leaves $0.0050 for the Opus pings and $0.0005 for the Sonnet pings. The old Opus row priced input and output at 1.25 times today's rates ($5 and $25 against $4 and $20), so the Opus part is $0.0050 / 1.25 = $0.0040; the Sonnet rates did not change. Together: $0.0045.
- Total: $1.079 + $0.059 + $0.104 + $0.010 + $0.0045 = $1.26 (rounded). The other 8 pings came from a version that did not record the model, so they are not priced.

Re-writes avoided (calculated from `lastActivityAtEpoch` and `lastPing.atEpoch`): in 9 sessions, activity came within 60 minutes after the last ping, so it found a cache the ping had kept warm. A ping goes out only after 50 minutes of quiet, but the file keeps only the latest activity, not the first one after the ping. Some of that activity may have come soon enough to find the cache warm without the ping, so 9 is an upper bound and the true count may be lower. Six of the 9 were Claude Opus 5.5 sessions with 1,202,273 tokens of context between them. Re-writing that would have cost 1,202,273 × $8 / 1,000,000 = $9.62 (calculated); reading it cost $0.24 (calculated).

Versions before this one priced Claude Opus 5.5 and Claude Sonnet 5.5 pings at older models' rates, so their `lastPing.costUsd` reads high. The figures above are recomputed from the token counts.

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
  "lastPing": { "at": "…", "atEpoch": 0, "ok": true, "reason": null, "cacheReadTokens": 0, "cacheWriteTokens": 0, "model": "…", "costUsd": 0 },
  "intervalMin": 50,
  "windowMin": 180, "windowHours": 3,
  "minTokens": 50000, "contextTokens": 200000, "skippedSmall": 0,
  "pulse": { "available": true, "reason": null, "checkedAt": "…", "checkedAtEpoch": 0, "agentsSeen": 1 },
  "maxHours": 12,
  "configWarnings": [],
  "cacheTtl": "1h", "cacheTtlReason": "Claude subscription default", "planUsageNote": null,
  "note": null,
  "stallMin": 20,
  "stallCheckMin": 5,
  "stallPrompt": false, "keepDays": 30, "wakes": 0, "pingsStopped": false,
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
- `messageSent` is `null` while a stall message waits for an idle main conversation, or when the stall prompt is off (`stallPrompt: false`), and `false` if sending failed.
- `pingsStopped` is `true` once a ping found the cache gone under the subscription default; no more pings go out in that session.
- Check freshness with `writtenAtEpochMs`. Treat a file older than the ping interval as out of date.

File name: a UUID session id is used as is. Any other character outside `A-Z a-z 0-9 _ -` becomes `%` plus two uppercase hex digits per UTF-8 byte (`a/b` becomes `a%2Fb`).

If a write fails, the old file is kept and `<session-id>.error.json` is written beside it with the error and the time. The next successful write removes it. If the error file cannot be written either, Bun Warmer tries to remove the old state file so you do not read a stale one as current. If that fails too, the status line says `STATE FILE NOT WRITTEN`, and only the age of `writtenAtEpochMs` shows the file is stale.

## Limitations

- Bun Warmer cannot ask Claude Code which cache length a request got. It reads the same settings and login kind Claude Code reads. On a subscription with no TTL setting it judges plan usage from the last rate-limit reading. If the plan crosses its limit after that reading and before the ping, that one ping can find a 5-minute cache gone and pay for a re-write; pings then stop for the session.
- The mod API cannot withdraw a queued prompt. Bun Warmer re-checks its state just before it sends a stall message, but if you run `/bunwarm off` or `/clear` in that instant, one stall message can still arrive late. The message starts with the time it was sent and says to ignore it if the mod was turned off or the subagent has finished.
- If a turn's completion event is never delivered, Bun Warmer keeps treating the main conversation as busy and holds stall messages until the session resets.
- A ping's events carry no marker. While a ping is in flight, a main-conversation event with no agent id is taken for the ping's and ignored. The next event after the ping counts.
- A subagent that streams for a long time inside one model step, with no tool call, can look quiet to the watchdog.
- The transcript layout the pulse reads is not a public Claude Code contract and may change. Idle times come from the wall clock, so they jump after the machine sleeps; the post-wake grace in the stall watchdog covers that.
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

MIT. See [LICENSE](LICENSE).
