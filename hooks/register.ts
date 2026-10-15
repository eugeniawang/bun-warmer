import type { EngineInterface, Register } from 'claude-code'

const MIN = 60 * 1000
const HOUR = 60 * MIN
const COLD_AFTER_MS = 60 * MIN
const MAX_INTERVAL_MIN = 55
const BIG_TOKENS = 50000
const PING_PROMPT = 'Reply with the single word: warm'

/** Prompt origins that are a person typing. Everything else (subagent returns, task notifications, peers, schedules, plugins, the SDK) is never blocked. */
const HUMAN_ORIGINS = ['composer', 'bridge']

type StalledAgent = { id: string; description: string; type: string; minutesSilent: number; firstFlaggedAt: number; messageSent: boolean | null }

type PingResult = { at: number; ok: boolean; reason: string | null; read: number | null; write: number | null }

type State = {
  sid: string
  armed: boolean
  armedAt: number
  lastPingAt: number
  lastActivityAt: number
  expiresAt: number
  refusals: number
  guardDrops: number
  lastPing: PingResult | null
  ctx: number
  intervalMs: number
  windowMs: number
  guard: 'warn' | 'refuse'
  ackedAt: number
  note: string | null
  stallMs: number
  stallCheckMs: number
  stalled: StalledAgent[]
}

/** ISO 8601 in the machine's local zone with its offset, e.g. 2026-10-14T22:39:00-07:00. Null for an unset time. */
export function isoLocal(ms: number): string | null {
  if (!ms) return null
  const d = new Date(ms)
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
}

function epoch(ms: number): number | null {
  return ms ? Math.floor(ms / 1000) : null
}

export function stateFile(s: State): Record<string, unknown> {
  return {
    sessionId: s.sid,
    armed: s.armed,
    armedAt: isoLocal(s.armedAt), armedAtEpoch: epoch(s.armedAt),
    lastPingAt: isoLocal(s.lastPingAt), lastPingAtEpoch: epoch(s.lastPingAt),
    lastActivityAt: isoLocal(s.lastActivityAt), lastActivityAtEpoch: epoch(s.lastActivityAt),
    expiresAt: isoLocal(s.expiresAt), expiresAtEpoch: epoch(s.expiresAt),
    refusals: s.refusals,
    guardDrops: s.guardDrops,
    lastPing: s.lastPing && {
      at: isoLocal(s.lastPing.at), atEpoch: epoch(s.lastPing.at), ok: s.lastPing.ok, reason: s.lastPing.reason,
      cacheReadTokens: s.lastPing.read, cacheWriteTokens: s.lastPing.write,
    },
    intervalMin: s.intervalMs / MIN,
    windowHours: s.windowMs / HOUR,
    note: s.note,
    stallMin: s.stallMs / MIN,
    stallCheckMin: s.stallCheckMs / MIN,
    stalledAgents: s.stalled.map(a => ({
      id: a.id, description: a.description, type: a.type, minutesSilent: a.minutesSilent,
      firstFlaggedAt: isoLocal(a.firstFlaggedAt), firstFlaggedAtEpoch: epoch(a.firstFlaggedAt), messageSent: a.messageSent,
    })),
  }
}

function fmtDur(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60000))
  const h = Math.floor(total / 60)
  const m = total % 60
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

function positive(text: string | undefined): number | null {
  if (text === undefined) return null
  const n = Number(text)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function freshState(): State {
  return {
    sid: '', armed: false, armedAt: 0, lastPingAt: 0, lastActivityAt: 0, expiresAt: 0, refusals: 0, guardDrops: 0,
    lastPing: null, ctx: 0, intervalMs: 50 * MIN, windowMs: 3 * HOUR, guard: 'warn', ackedAt: 0, note: null,
    stallMs: 20 * MIN, stallCheckMs: 5 * MIN, stalled: [],
  }
}

const s = freshState()
let timer: { cancel: () => void } | null = null
let stallTimer: { cancel: () => void } | null = null
/** Last event seen per subagent id (turn.step, turn.complete, tool.call carrying that agentId). Not persisted. */
const lastEventAt = new Map<string, number>()
let pinging = false
let writes: Promise<void> = Promise.resolve()

// The file is written beside its final name and moved over it, so a reader never sees half a file.
function persist($: EngineInterface) {
  writes = writes.then(async () => {
    if (!s.sid) return
    try {
      const home = await $.env.get('HOME')
      if (!home) return
      const dir = `${home}/.claude/bun-warmer`
      const safe = s.sid.replace(/[^A-Za-z0-9_-]/g, '_')
      const tmp = `${dir}/.${safe}.json.tmp`
      await $.fs.write(tmp, JSON.stringify(stateFile(s), null, 2) + '\n')
      const moved = await $.process.run(['mv', '-f', tmp, `${dir}/${safe}.json`])
      if (moved.exitCode !== 0) $.ui.log(`bun-warmer: could not write the state file (${moved.stderr.trim()})`)
    } catch (err) {
      $.ui.log(`bun-warmer: could not write the state file (${err instanceof Error ? err.message : String(err)})`)
    }
  })
  return writes
}

function status($: EngineInterface, now: number) {
  if (!s.armed) return $.ui.status(s.note ? `bun-warmer off: ${s.note}${stallText()}` : stallText().slice(3) || undefined)
  const fail = s.lastPing && !s.lastPing.ok ? ` · last ping FAILED: ${s.lastPing.reason}` : ''
  const stall = stallText()
  const base = Math.max(s.lastActivityAt, s.lastPingAt)
  const next = !base ? 'waiting for the first turn' : now - base >= COLD_AFTER_MS ? 'cache cold, waiting for activity' : `ping in ${fmtDur(base + s.intervalMs - now)}`
  return $.ui.status(`bun-warmer ${fmtDur(s.expiresAt - now)} left · ${next}${fail}${stall}`)
}

function stallText(): string {
  if (!s.stalled.length) return ''
  return ` · STALLED: ${s.stalled.map(a => `${a.description} ${a.minutesSilent}m`).join(', ')}`
}

function cancel() {
  if (timer) timer.cancel()
  timer = null
}

function schedule($: EngineInterface, now: number) {
  cancel()
  if (!s.armed) return
  const base = Math.max(s.lastActivityAt, s.lastPingAt)
  const coldAt = base ? base + COLD_AFTER_MS : 0
  // A cold cache is not pinged: that would pay the full rewrite. Only expiry is watched until activity returns.
  const pingAt = base && now < coldAt ? base + s.intervalMs : s.expiresAt
  const due = Math.min(pingAt, s.expiresAt)
  timer = $.clock.after(Math.max(1000, due - now), () => { void tick($) })
}

async function disarm($: EngineInterface, why: string) {
  cancel()
  s.armed = false
  s.note = why
  const now = await $.clock.now()
  status($, now)
  await persist($)
}

async function arm($: EngineInterface, now: number) {
  s.armed = true
  s.armedAt = now
  s.expiresAt = now + s.windowMs
  s.note = null
  schedule($, now)
  status($, now)
  await persist($)
}

async function hasActiveAgents($: EngineInterface): Promise<boolean> {
  try {
    const list = await $.agent.list()
    return list.some(a => a.status === 'running' || a.status === 'pending' || a.status === 'waiting')
  } catch {
    return false
  }
}

function touchAgent(id: string | undefined, now: number) {
  if (!id) return
  lastEventAt.set(id, now)
}

function stallMessage(a: StalledAgent): string {
  return `Bun Warmer: subagent ${a.description} (${a.id}) has shown running but silent for ${a.minutesSilent} minutes. Decide: wait, stop it, or respawn it.`
}

/**
 * One watchdog pass. Reads $.agent.list (local, no tokens), flags a running agent silent for stallMs once,
 * clears a flag when the agent is no longer running or has produced an event since. Never stops anything.
 * The one message to the orchestrator goes through $.prompt.submit (origin kind 'plugin'); the calling plugin's
 * own prompt.submit hook is skipped by the engine, so the guard cannot drop it.
 */
export async function stallCheck($: EngineInterface) {
  let list
  try {
    list = await $.agent.list()
  } catch {
    return
  }
  const now = await $.clock.now()
  const running = new Map<string, { description: string; type: string }>()
  for (const a of list) {
    if (!a || !a.id || a.status !== 'running') continue
    running.set(a.id, { description: a.description, type: a.type })
    // An agent never seen producing an event is measured from the first time the watchdog saw it running.
    if (!lastEventAt.has(a.id)) lastEventAt.set(a.id, now)
  }
  let changed = false
  s.stalled = s.stalled.filter(f => {
    const keep = running.has(f.id) && now - (lastEventAt.get(f.id) ?? now) >= s.stallMs
    if (!keep) changed = true
    return keep
  })
  const fresh: StalledAgent[] = []
  for (const [id, info] of running) {
    const silent = now - (lastEventAt.get(id) ?? now)
    if (silent < s.stallMs) continue
    const minutes = Math.round(silent / MIN)
    const known = s.stalled.find(f => f.id === id)
    if (known) {
      if (known.minutesSilent !== minutes) { known.minutesSilent = minutes; changed = true }
      continue
    }
    const entry: StalledAgent = { id, description: info.description, type: info.type, minutesSilent: minutes, firstFlaggedAt: now, messageSent: null }
    s.stalled.push(entry)
    fresh.push(entry)
    changed = true
  }
  for (const f of fresh) {
    try {
      const r = await Promise.race([
        $.prompt.submit({ text: stallMessage(f) }),
        // submit resolves when the prompt enters or is queued; do not hold the watchdog on a busy loop forever.
        new Promise<'pending'>(res => { $.clock.after(15000, () => res('pending')) }),
      ])
      f.messageSent = r === 'pending' ? true : !(r && 'drop' in r && r.drop)
    } catch (err) {
      f.messageSent = false
      $.ui.log(`bun-warmer: could not message the orchestrator about a stalled subagent (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  if (changed) {
    status($, now)
    await persist($)
  }
}

function scheduleStall($: EngineInterface) {
  if (stallTimer) stallTimer.cancel()
  stallTimer = $.clock.after(s.stallCheckMs, () => { void stallCheck($).finally(() => { if (stallTimer) scheduleStall($) }) })
}

function stopStall() {
  if (stallTimer) stallTimer.cancel()
  stallTimer = null
}

async function tick($: EngineInterface) {
  timer = null
  if (!s.armed) return
  const now = await $.clock.now()
  if (now >= s.expiresAt) {
    // Subagents working or turns still arriving mean the session is busy, not finished.
    if (now - s.lastActivityAt < s.intervalMs || await hasActiveAgents($)) return arm($, now)
    return disarm($, 'window expired')
  }
  const base = Math.max(s.lastActivityAt, s.lastPingAt)
  if (!base || now - base >= COLD_AFTER_MS || now - base < s.intervalMs - 1000) {
    schedule($, now)
    return status($, now)
  }
  await ping($, now)
}

async function ping($: EngineInterface, now: number) {
  if (pinging) return
  pinging = true
  let result: PingResult
  try {
    let reply
    try {
      reply = await $.model.fork({ prompt: PING_PROMPT })
    } catch (err) {
      reply = null
      result = { at: now, ok: false, reason: `ping threw: ${err instanceof Error ? err.message : String(err)}`, read: null, write: null }
    }
    if (reply === null) {
      result ??= { at: now, ok: false, reason: 'the engine did not send the ping', read: null, write: null }
    } else if (reply.isAnswered === false) {
      const why = reply.reason === 'nothing-to-fork' ? 'no conversation to warm yet'
        : reply.reason === 'api-error' ? `the API call failed${reply.status == null ? '' : ` (${reply.status})`}`
        : reply.reason === 'aborted' ? 'the ping was interrupted'
        : 'the ping returned no text'
      result = { at: now, ok: false, reason: why, read: null, write: null }
    } else {
      const u = reply.usage
      const warm = u.cache_read_input_tokens > 0 && u.cache_creation_input_tokens < 0.1 * u.cache_read_input_tokens
      result = warm
        ? { at: now, ok: true, reason: null, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens }
        : { at: now, ok: false, reason: `the cache was already gone (read ${u.cache_read_input_tokens}, wrote ${u.cache_creation_input_tokens} tokens)`, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens }
    }
  } finally {
    pinging = false
  }
  s.lastPing = result
  // Even a failed ping is an attempt that was paid for or refused; do not retry sooner than one interval.
  s.lastPingAt = now
  if (!result.ok) s.refusals++
  schedule($, now)
  status($, now)
  await persist($)
}

async function activity($: EngineInterface, human: boolean) {
  const now = await $.clock.now()
  s.lastActivityAt = now
  if (human) return arm($, now)
  if (s.armed) schedule($, now)
  status($, now)
  await persist($)
}

async function refreshCtx($: EngineInterface) {
  try {
    const live = (await $.session.usage()).context.tokens
    if (live && live > 0) s.ctx = live
  } catch { /* usage is advisory */ }
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    s.sid = await $.session.id()
    const envInterval = positive(await $.env.get('BUN_WARMER_INTERVAL_MIN'))
    const envWindow = positive(await $.env.get('BUN_WARMER_WINDOW_HOURS'))
    const optInterval = typeof options.intervalMin === 'number' && options.intervalMin > 0 ? options.intervalMin : 50
    const optWindow = typeof options.windowHours === 'number' && options.windowHours > 0 ? options.windowHours : 3
    s.intervalMs = Math.min(envInterval ?? optInterval, MAX_INTERVAL_MIN) * MIN
    s.windowMs = (envWindow ?? optWindow) * HOUR
    s.stallMs = (positive(await $.env.get('BUN_WARMER_STALL_MIN')) ?? 20) * MIN
    s.stallCheckMs = (positive(await $.env.get('BUN_WARMER_STALL_CHECK_MIN')) ?? 5) * MIN
    s.guard = options.guard === 'refuse' ? 'refuse' : 'warn'
    await $.command.register({ name: 'bunwarm', description: 'Bun Warmer: status, on, or off for the cache-warming pings', argumentHint: '[status | on | off]', immediate: true })
    await refreshCtx($)
    await arm($, await $.clock.now())
    scheduleStall($)
    return r
  })

  on('session.end', async ($, e, next) => {
    stopStall()
    await disarm($, e.reason === 'clear' ? 'cleared' : 'session ended')
    return next(e)
  })

  on('command.run', { command: 'bunwarm' }, async ($, e) => {
    const word = String(e.args ?? '').trim()
    const now = await $.clock.now()
    if (word === 'off') { await disarm($, 'turned off'); return { text: 'bun-warmer is off for this session' } }
    if (word === 'on') { await arm($, now); return { text: `bun-warmer on for ${fmtDur(s.windowMs)}, a ping after ${fmtDur(s.intervalMs)} of quiet` } }
    if (!s.armed) return { text: `bun-warmer is off${s.note ? ` (${s.note})` : ''}` }
    const fail = s.lastPing && !s.lastPing.ok ? `; last ping FAILED: ${s.lastPing.reason}` : s.lastPing ? '; last ping ok' : ''
    return { text: `bun-warmer on, ${fmtDur(s.expiresAt - now)} left, ${s.refusals} failed or refused pings${fail}` }
  })

  on('prompt.submit', async ($, e, next) => {
    const isHuman = HUMAN_ORIGINS.includes(e.origin.kind)
    if (!isHuman) {
      // A subagent return, task notification, peer, schedule or plugin message is never held back.
      await activity($, false)
      return next(e)
    }
    const now = await $.clock.now()
    const cold = s.lastActivityAt > 0 && now - s.lastActivityAt >= COLD_AFTER_MS
    const typed = typeof e.text === 'string' && !e.text.trimStart().startsWith('/')
    if (typed && cold && s.ctx >= BIG_TOKENS) {
      const msg = `bun-warmer: the prompt cache went cold ${fmtDur(now - s.lastActivityAt - COLD_AFTER_MS)} ago, so this send re-writes about ${s.ctx.toLocaleString('en-US')} tokens at the cache-write rate.`
      if (s.guard === 'refuse' && s.ackedAt !== s.lastActivityAt) {
        s.ackedAt = s.lastActivityAt
        s.guardDrops++
        await persist($)
        return { drop: `${msg} Send it again to pay it.` }
      }
      if (s.guard !== 'refuse') $.ui.log(`${msg} Sending anyway.`)
    }
    await activity($, true)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // Any loop counts, subagents included: an orchestrator waiting on them is busy, not idle.
    touchAgent(e.agentId, await $.clock.now())
    await activity($, false)
    yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    touchAgent(e.agentId, await $.clock.now())
    await refreshCtx($)
    await activity($, false)
    return r
  })

  on('tool.call', async ($, e, next) => {
    try { touchAgent(e.agentId, await $.clock.now()) } catch { /* a stall clock must never block a tool call */ }
    return next(e)
  })
}
