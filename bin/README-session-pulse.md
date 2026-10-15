# session-pulse

Stateless Python 3 (stdlib only) script that reports whether a Claude Code session or its subagents are still writing, from raw transcripts. No model, no network, no disk writes, no external commands.

Usage: `session-pulse.py <session-id> [--projects-dir ~/.claude/projects] [--previous <json-file>] [--now <epoch>] [--loop-threshold 5]`

Exit 0 always except bad arguments (exit 2, including a session id with path separators or odd characters). When it cannot tell, it prints `{"available": false, "reason": ...}`. It never reports "quiet"; it reports idle seconds and the caller decides.

## Layout observed on disk (Confirmed against a real session, 2026-10-14)

- Main transcript: `<projects-dir>/<encoded-cwd>/<session-id>.jsonl`
- Subagents: `<projects-dir>/<encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl`, with `agent-<id>.meta.json` beside each (keys seen: agentType, description, toolUseId, spawnDepth, requestShape, requestNonInteractive, model).
- One JSON object per line. Top-level `type` values seen: assistant, user, system, attachment, api-request, api-request-blob, api-request-shape, queue-operation, mode, permission-mode, last-prompt, agent-setting, file-history-snapshot, and a few others.
- Each `assistant` line carries ONE content block in `message.content[]` (thinking, text, tool_use, server_tool_use). A `tool_use` block has `id`, `name`, `input`. The matching `user` line holds a `tool_result` block with `tool_use_id`.
- `api-request-blob` lines ALSO contain tool_use/tool_result blocks (request copies). The script counts only `assistant` and `user` lines.
- The newest lines are often metadata (`system`, `attachment`), so `lastLineKind` can be `other:system` while the conversation is mid-turn. `lastConversationKind` is the kind of the last assistant/user line.
- Most lines carry an ISO `timestamp` (about a third do not). Tool in flight time uses the tool_use line's timestamp (`toolInFlightSource: "line_timestamp"`), else the file mtime (`"file_mtime"`).

## Output keys

available, reason, sessionId, now, pulseVersion, main, agents[], newestWriteAt, newestIdleSeconds, anyAgentWriting (an agent file written within 60 s), warnings. Per file: path, mtime, size, idleSeconds, lastLineKind, lastConversationKind, toolInFlight, toolInFlightSeconds, toolInFlightSource, repeatedToolCalls (longest run of identical name+input calls in the tail), loopSuspected (run >= threshold), grewSincePrevious; agents also id, agentType, description.

lastLineKind values: tool_use, tool_result, assistant_text, assistant_thinking, user_text, assistant_other, user_other, other:<type>, unknown (last complete line did not parse, or the tail held no complete line), empty (zero-byte file).

## Behaviors

- Reads at most the last 64 KB of each file. A partial last line (write in progress) is dropped; the previous complete line sets `lastLineKind`. A line over 64 KB yields `unknown`.
- Growth: only against a snapshot passed with `--previous` (a prior output of this script). No snapshot, wrong session, or unreadable snapshot gives `grewSincePrevious: null`, never false. A file absent from the snapshot counts as grown; a file that shrank gives null.
- Symlinks resolving outside the projects dir are ignored. A file that vanishes mid-read becomes an agent entry with `error`, not a crash.

## Known limits

- Workflow agents are not in this layout (the mod types say workflow agents are not in `$.agent.list()`); their activity is invisible here. Not checked whether `claude -p` headless runs write the same layout.
- The layout and write timing are not a public Anthropic contract. A long model turn writes nothing until a block completes, so idle seconds there look like silence; the script reports numbers only and does not call it a stall.
- A stale file can look plausible: always read `idleSeconds` next to `toolInFlight`.
- Tail window: a tool_use older than 64 KB of transcript, or its result, is not seen.

## Sleep/wake and --monotonic-check note

Idle times come from the wall clock. After the Mac sleeps, `now` jumps while mtimes stay old, so every idle time looks huge, and a running process may also resume with stale state. The script does not try to solve this. The caller must apply its own grace after wake (for example, ignore pulses for a few minutes after detecting a gap between its own consecutive ticks, using a monotonic clock) before acting on any idle number. A future `--monotonic-check` option is deliberately not implemented.

## Tests

`python3 -m unittest discover -s tests/pulse`
