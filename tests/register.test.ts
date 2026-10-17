import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { ModelForkResult, On, PromptOrigin, TurnCompleteInput, TurnStepInput } from 'claude-code'

import { safeName } from '../hooks/register'

tier('user')

const MIN = 60 * 1000
const HOUR = 60 * MIN
const START = 1_800_000_000_000

type ForkAnswer = ModelForkResult | { read: number; write: number }

// The world beneath the mod: env, file system, mv, fork answers, all in memory.
function world(on: On, forkAnswers: ForkAnswer[] = [], env: Record<string, string> = {}) {
  const files = new Map<string, string>()
  const finals = new Map<string, string>()
  const forks: number[] = []
  const status: Array<string | undefined> = []
  const logs: string[] = []
  const prompts: string[] = []
  let agents: Array<{ status: string; id?: string }> = []
  let forkHook: (() => Promise<void>) | null = null
  let sid = 'S1'
  let ctxTokens = 200000
  const fail = { mv: false, write: false, errWrite: false, rmFinal: false, rmErr: false }
  // These tests predate quiet hours and run at an arbitrary hour of the machine's day: quiet hours stay off unless a test sets them. tests/quiet.test.ts covers them.
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/t' : env[e.name] ?? (e.name === 'BUN_WARMER_QUIET_HOURS' ? 'off' : undefined) }))
  on('fs.write', ($, e) => {
    if (fail.write && e.path.endsWith('.tmp')) throw new Error('disk full')
    if (fail.errWrite && e.path.endsWith('.error.json')) throw new Error('disk full')
    files.set(e.path, e.text); return { value: undefined }
  })
  on('process.run', ($, e) => {
    const [cmd, , from, to] = e.argv
    const done = (exitCode: number, stderr = '') => ({ value: { exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    if (cmd === 'mv') {
      if (fail.mv) return done(1, 'Permission denied')
      finals.set(to, files.get(from) ?? ''); files.delete(from)
    }
    if (cmd === 'rm') {
      if (fail.rmFinal && from.endsWith('.json') && !from.endsWith('.error.json')) return done(1, 'Operation not permitted')
      if (fail.rmErr && from.endsWith('.error.json')) return done(1, 'Operation not permitted')
      files.delete(from); finals.delete(from)
    }
    return done(0)
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: sid }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'hi', toolUses: [] }] as never }))
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] as never }))
  on('session.usage', () => ({ value: { startedAt: START, context: { window: 1000000, tokens: ctxTokens }, rateLimits: [] } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('agent.list', () => ({ value: agents as never }))
  on('ui.status', ($, e) => { status.push(e.text); return { value: undefined } })
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => { prompts.push(e.text); return { text: e.text } })
  on('turn.step', async function* ($, e) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never })
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('model.fork', async () => {
    forks.push(forks.length)
    if (forkHook) await forkHook()
    const a = forkAnswers.shift()
    if (a === undefined) return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as unknown as ModelForkResult }
    if ('isAnswered' in a) return { value: a }
    return { value: { isAnswered: true, text: 'warm', usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: a.read, cache_creation_input_tokens: a.write } } as ModelForkResult }
  })
  return {
    forks, status, logs, prompts,
    state: (id = 'S1') => JSON.parse(finals.get(`/home/t/.claude/bun-warmer/${id}.json`) ?? 'null') as Record<string, any>,
    fail, files, finals,
    onFork: (f: () => Promise<void>) => { forkHook = f },
    setSid: (id: string) => { sid = id },
    setCtx: (n: number) => { ctxTokens = n },
    setAgents: (a: Array<{ status: string; id?: string }>) => { agents = a },
  }
}

const warm: ForkAnswer = { read: 200000, write: 10 }
const start = { surface: null, isInteractive: false, cwd: '/work' } as const
const composer: PromptOrigin = { kind: 'composer' }
const answer = (over: Partial<TurnCompleteInput> = {}) => ({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer', ...over }) as TurnCompleteInput
const step = (over: Partial<TurnStepInput> = {}) => ({ turnId: 't1', index: 0, model: 'm', messageCount: 3, ...over }) as TurnStepInput
const say = (text: string, origin: PromptOrigin) => ({ text, wait: false, origin })

describe('bun-warmer', () => {
  test('pings after the interval of quiet, then again each interval', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm], { BUN_WARMER_WINDOW_HOURS: '3' })
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(49 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(2 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.state().lastPing.ok).toBe(true)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('the interval and window come from the environment', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm], { BUN_WARMER_INTERVAL_MIN: '10', BUN_WARMER_WINDOW_HOURS: '1' })
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(11 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.state().intervalMin).toBe(10)
    expect(w.state().windowHours).toBe(1)
  })

  test('the window expires, pings stop, and the state file says so', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm, warm, warm, warm, warm], { BUN_WARMER_INTERVAL_MIN: '50', BUN_WARMER_WINDOW_HOURS: '1' })
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(50 * MIN + 1000)
    expect(w.forks.length).toBe(1)
    await clock.advance(30 * MIN)
    expect(w.state().armed).toBe(false)
    const before = w.forks.length
    await clock.advance(5 * HOUR)
    expect(w.forks.length).toBe(before)
  })

  test('the state file holds ids, ISO times with a zone, epoch seconds and refusals', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(51 * MIN)
    const st = w.state()
    expect(st.sessionId).toBe('S1')
    expect(st.armedAtEpoch).toBe(Math.floor(START / 1000))
    expect(st.lastPingAtEpoch).toBe(Math.floor((START + 50 * MIN) / 1000))
    expect(st.expiresAtEpoch).toBe(Math.floor((START + 90 * MIN) / 1000)) // the default window is 90 minutes
    for (const k of ['armedAt', 'lastPingAt', 'lastActivityAt', 'expiresAt']) expect(st[k]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/)
    expect(st.refusals).toBe(0)
  })

  test('subagent turns update lastActivityAt and push the next ping back', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(40 * MIN)
    for await (const _ of $.turn.step(step({ agentId: 'sub1' }))) { /* drain */ }
    expect(w.state().lastActivityAtEpoch).toBe(Math.floor((START + 40 * MIN) / 1000))
    await clock.advance(30 * MIN)
    expect(w.forks.length).toBe(0)
    await $.turn.complete(answer({ agentId: 'sub1' }))
    expect(w.state().lastActivityAtEpoch).toBe(Math.floor((START + 70 * MIN) / 1000))
    await clock.advance(51 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('a failed ping is recorded as failed, counted, and shown, never as success', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(51 * MIN)
    const st = w.state()
    expect(st.lastPing.ok).toBe(false)
    expect(st.lastPing.reason).toMatch(/API call failed \(529\)/)
    expect(st.refusals).toBe(1)
    expect(w.status.at(-1)).toMatch(/FAILED/)
  })

  test('a ping that finds the cache gone is recorded as failed', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 0, write: 200000 }])
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(51 * MIN)
    expect(w.state().lastPing.ok).toBe(false)
    expect(w.state().refusals).toBe(1)
  })

  test('a cold session passes every non-human prompt through, even in refuse mode', { options: { guard: 'refuse' } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(2 * HOUR + 30 * MIN)
    const origins: PromptOrigin[] = [
      { kind: 'sdk' }, { kind: 'task-notification' }, { kind: 'scheduled-trigger' }, { kind: 'peer' }, { kind: 'peer-send-message' },
      { kind: 'projects-relay' }, { kind: 'channel', server: 'slack' }, { kind: 'coordinator' }, { kind: 'observer' }, { kind: 'observer-activity' },
      { kind: 'auto-continuation' }, { kind: 'unclassified' }, { kind: 'slack-ping' }, { kind: 'plugin', name: 'x', asUser: true },
    ]
    for (const origin of origins) {
      await clock.advance(61 * MIN)
      const r = await $.prompt.submit(say('subagent report', origin))
      expect(r.drop).toBe(undefined)
    }
    expect(w.prompts.length).toBe(origins.length)
    expect(w.state().guardDrops).toBe(0)
  })

  test('a human prompt into a cold session warns by default and is not dropped', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(2 * HOUR + 30 * MIN)
    const r = await $.prompt.submit(say('hello', composer))
    expect(r.drop).toBe(undefined)
    expect(w.logs.some(l => /went cold/.test(l))).toBe(true)
  })

  test('refuse mode (opt-in) drops a human cold send once, then lets the resend through', { options: { guard: 'refuse' } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(2 * HOUR + 30 * MIN)
    expect((await $.prompt.submit(say('hello', composer))).drop).toMatch(/Send it again/)
    expect((await $.prompt.submit(say('hello', composer))).drop).toBe(undefined)
    expect(w.state().guardDrops).toBe(1)
    await clock.advance(2 * HOUR)
    expect((await $.prompt.submit(say('report', { kind: 'task-notification' }))).drop).toBe(undefined)
  })

  test('a successful ping keeps the cache warm for the guard: activity 110m ago, ping 10m ago, no drop and no warning', { options: { guard: 'refuse' } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm], { BUN_WARMER_WINDOW_HOURS: '3' })
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(101 * MIN) // pings at +50m and +100m, both warm
    expect(w.forks.length).toBe(2)
    expect(w.state().lastPing.ok).toBe(true)
    await clock.advance(9 * MIN) // activity 110m ago, last successful ping 10m ago
    expect(w.status.at(-1)).toMatch(/ · warm · /)
    const r = await $.prompt.submit(say('hello', composer))
    expect(r.drop).toBe(undefined)
    expect(w.logs.some(l => /went cold/.test(l))).toBe(false)
    expect(w.state().guardDrops).toBe(0)
  })

  test('a failed ping does not keep the cache warm: refuse still drops the first send, timed from the last good ping', { options: { guard: 'refuse' } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm], { BUN_WARMER_WINDOW_HOURS: '3' }) // +50m ping ok, +100m ping fails
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(101 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.state().lastPing.ok).toBe(false)
    await clock.advance(10 * MIN) // activity 111m ago, failed ping 11m ago, last good ping 61m ago
    expect((await $.prompt.submit(say('hello', composer))).drop).toMatch(/went cold 1m ago.*Send it again/)
    expect((await $.prompt.submit(say('hello', composer))).drop).toBe(undefined)
    expect(w.state().guardDrops).toBe(1)
  })

  test('activity and the last good ping both over 60m ago: cold, refuse drops once, a later cold period re-arms', { options: { guard: 'refuse' } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm]) // default 90m window: one ping at +50m, then the window expires
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(51 * MIN)
    expect(w.state().lastPing.ok).toBe(true)
    await clock.advance(70 * MIN) // activity 121m ago, ping 71m ago
    expect(w.state().armed).toBe(false)
    expect((await $.prompt.submit(say('hello', composer))).drop).toMatch(/went cold 11m ago/)
    expect((await $.prompt.submit(say('hello', composer))).drop).toBe(undefined)
    expect(w.state().guardDrops).toBe(1)
    // The resend was activity and re-armed the mod; its next ping fails (no warm answer left), so the cache goes cold again and the guard drops again, once.
    await clock.advance(61 * MIN)
    expect(w.state().lastPing.ok).toBe(false)
    expect((await $.prompt.submit(say('again', composer))).drop).toMatch(/Send it again/)
    expect((await $.prompt.submit(say('again', composer))).drop).toBe(undefined)
  })

  test('/clear resets the session: new id, no stale context, old file left disarmed', { options: { guard: 'refuse' } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(30 * MIN)
    await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } } as never)
    expect(w.state('S1').armed).toBe(false)
    expect(w.state('S1').note).toBe('cleared')
    w.setSid('S2')
    await clock.advance(2 * HOUR)
    // stale ctx (200k) and stale lastActivityAt must not trigger a cold-send refusal in the fresh session
    const r = await $.prompt.submit(say('fresh start', composer))
    expect(r.drop).toBe(undefined)
    const st = w.state('S2')
    expect(st.sessionId).toBe('S2')
    expect(st.armed).toBe(true)
    expect(st.guardDrops).toBe(0)
    expect(st.refusals).toBe(0)
    expect(st.lastPing).toBe(null)
    expect(w.state('S1').sessionId).toBe('S1')
    expect(w.state('S1').armed).toBe(false)
  })

  test('resume: a new session.start under another id starts clean', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(51 * MIN)
    expect(w.state('S1').refusals + (w.state('S1').lastPing ? 1 : 0)).toBeGreaterThan(0)
    await $.session.end({ reason: 'resume', sessionId: 'S1', resume: { id: 'S1' } } as never)
    w.setSid('S2')
    await $.session.start(start)
    const st = w.state('S2')
    expect(st.sessionId).toBe('S2')
    expect(st.armed).toBe(true)
    expect(st.lastPing).toBe(null)
    expect(st.refusals).toBe(0)
    expect(st.stalledAgents).toEqual([])
    expect(w.state('S1').armed).toBe(false)
  })

  test('compaction clears the context size so the guard cannot act on it until a response sets it', { options: { guard: 'refuse' } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(2 * HOUR + 30 * MIN)
    await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'long history', toolUses: [] }] })
    // the usage call still returns the stale pre-compaction number, but nothing re-reads it before the next response
    const r = await $.prompt.submit(say('after compact', composer))
    expect(r.drop).toBe(undefined)
    expect(w.state().guardDrops).toBe(0)
    // a response sets the new size; a later cold send is guarded again
    w.setCtx(80000)
    await $.turn.complete(answer())
    await clock.advance(2 * HOUR)
    expect((await $.prompt.submit(say('again', composer))).drop).toMatch(/Send it again/)
  })

  test('an active subagent at window expiry extends the window instead of closing it', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm, warm, warm, warm, warm], { BUN_WARMER_INTERVAL_MIN: '50', BUN_WARMER_WINDOW_HOURS: '1' })
    await $.session.start(start)
    await $.turn.complete(answer())
    w.setAgents([{ status: 'running' }])
    await clock.advance(70 * MIN)
    expect(w.state().armed).toBe(true)
    expect(w.state().expiresAtEpoch).toBeGreaterThan(Math.floor((START + 60 * MIN) / 1000))
    w.setAgents([])
    await clock.advance(3 * HOUR)
    expect(w.state().armed).toBe(false)
  })

  test('pending and waiting agents do not extend the window; running ones do', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm, warm, warm, warm, warm, warm, warm], { BUN_WARMER_INTERVAL_MIN: '50', BUN_WARMER_WINDOW_HOURS: '1' })
    await $.session.start(start)
    await $.turn.complete(answer())
    w.setAgents([{ status: 'pending' }, { status: 'waiting' }])
    await clock.advance(3 * HOUR)
    expect(w.state().armed).toBe(false)
    expect(w.state().note).toBe('window expired')
  })

  test('a running agent cannot extend the window past BUN_WARMER_MAX_HOURS; the reason is recorded', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { BUN_WARMER_INTERVAL_MIN: '50', BUN_WARMER_WINDOW_HOURS: '1', BUN_WARMER_MAX_HOURS: '3' })
    await $.session.start(start)
    w.setAgents([{ status: 'running' }])
    await clock.advance(2 * HOUR)
    expect(w.state().armed).toBe(true)
    expect(w.state().maxHours).toBe(3)
    expect(w.state().expiresAtEpoch).toBeLessThanOrEqual(Math.floor((START + 3 * HOUR) / 1000))
    await clock.advance(2 * HOUR)
    expect(w.state().armed).toBe(false)
    expect(w.state().note).toMatch(/maximum of 3h00m reached/)
  })

  test('a ping does not move lastActivityAt, even when the ping call itself emits turn events', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm, warm])
    await $.session.start(start)
    await $.turn.complete(answer())
    const before = w.state().lastActivityAtEpoch
    expect(before).toBe(Math.floor(START / 1000))
    w.onFork(async () => {
      for await (const _ of $.turn.step(step())) { /* drain */ }
      await $.turn.complete(answer())
    })
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBeGreaterThanOrEqual(1)
    expect(w.state().lastPingAtEpoch).toBeGreaterThan(before)
    expect(w.state().lastActivityAtEpoch).toBe(before)
  })

  test('a failed mv removes the temp file, records an error file, and a later success clears it', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    const dir = '/home/t/.claude/bun-warmer'
    await $.session.start(start)
    expect(w.state().armed).toBe(true)
    const okWrittenAt = w.state().writtenAtEpoch
    expect(okWrittenAt).toBe(Math.floor(START / 1000))
    w.fail.mv = true
    await clock.advance(5 * MIN)
    await $.turn.complete(answer())
    expect([...w.files.keys()].some(k => k.endsWith('.tmp'))).toBe(false)
    const err = JSON.parse(w.files.get(`${dir}/S1.error.json`) ?? 'null')
    expect(err.error).toMatch(/mv failed: Permission denied/)
    expect(w.logs.some(l => /could not write the state file/.test(l))).toBe(true)
    // the old final file is still there, but its writtenAt shows it is old
    expect(w.state().writtenAtEpoch).toBe(okWrittenAt)
    w.fail.mv = false
    await $.turn.complete(answer())
    expect(w.files.has(`${dir}/S1.error.json`)).toBe(false)
    expect(w.state().writtenAtEpoch).toBeGreaterThan(okWrittenAt)
  })

  test('a failed write leaves no temp file and records an error file', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [])
    w.fail.write = true
    await $.session.start(start)
    expect(w.state()).toBe(null)
    expect([...w.files.keys()].some(k => k.endsWith('.tmp'))).toBe(false)
    expect(JSON.parse(w.files.get('/home/t/.claude/bun-warmer/S1.error.json') ?? 'null').error).toMatch(/write failed/)
  })

  test('a double failure removes the old state file; if that fails too the status line and log say so', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(start)
    expect(w.state()).not.toBe(null)
    w.fail.mv = true
    w.fail.errWrite = true
    await clock.advance(5 * MIN)
    await $.turn.complete(answer())
    expect(w.state()).toBe(null) // the old final file was removed, so it cannot pass for current
    expect(w.logs.some(l => /removed the old state file/.test(l))).toBe(true)
    // now the removal fails as well: the old file stays, and the mod says so
    w.fail.mv = false
    w.fail.errWrite = false
    await $.turn.complete(answer())
    expect(w.state()).not.toBe(null)
    const oldMs = w.state().writtenAtEpochMs
    w.fail.mv = true
    w.fail.errWrite = true
    w.fail.rmFinal = true
    await clock.advance(1500)
    await $.turn.complete(answer())
    expect(w.state().writtenAtEpochMs).toBe(oldMs)
    expect(w.status.at(-1)).toMatch(/STATE FILE NOT WRITTEN and the old one could not be removed/)
    expect(w.logs.some(l => /could not be removed/.test(l))).toBe(true)
    w.fail.mv = false; w.fail.errWrite = false; w.fail.rmFinal = false
    await $.turn.complete(answer())
    expect(w.state().writtenAtEpochMs).toBeGreaterThan(oldMs)
    expect(w.status.at(-1) ?? '').not.toMatch(/NOT WRITTEN/)
  })

  test('writtenAt has millisecond precision, with epoch milliseconds', async ($, on) => {
    mock.clock(on, { now: START + 123 })
    const w = world(on, [])
    await $.session.start(start)
    expect(w.state().writtenAt).toMatch(/T\d\d:\d\d:\d\d\.123[+-]\d\d:\d\d$/)
    expect(w.state().writtenAtEpochMs).toBe(START + 123)
  })

  test('a lone surrogate encodes as U+FFFD bytes, and valid characters as their UTF-8 bytes', async () => {
    expect(safeName('a\uD800b')).toBe('a%EF%BF%BDb')
    expect(safeName('\uDC00')).toBe('%EF%BF%BD')
    expect(safeName('é')).toBe('%C3%A9')
    expect(safeName('\u{1F600}')).toBe('%F0%9F%98%80')
    expect(safeName('a\uD800')).not.toMatch(/%D800/)
  })

  test('the session id becomes an injective file name', async () => {
    expect(safeName('a/b')).not.toBe(safeName('a?b'))
    expect(safeName('a_b')).not.toBe(safeName('a/b'))
    expect(safeName('a%2Fb')).not.toBe(safeName('a/b'))
    expect(safeName('abc-123_X')).toBe('abc-123_X')
    expect(safeName('../x')).not.toMatch(/[./]/)
  })

  test('bridge origin counts as a person: guarded and arms the window', { options: { guard: 'refuse' } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(2 * HOUR + 30 * MIN)
    expect((await $.prompt.submit(say('from phone', { kind: 'bridge' } as PromptOrigin))).drop).toMatch(/Send it again/)
    expect(w.state().guardDrops).toBe(1)
  })

  test('slash commands pass the guard even into a cold, large session', { options: { guard: 'refuse' } }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(2 * HOUR + 30 * MIN)
    expect((await $.prompt.submit(say('/compact', composer))).drop).toBe(undefined)
    expect(w.state().guardDrops).toBe(0)
  })
  test('a subagent that completes during a ping moves lastActivityAt; the ping\'s own events still do not', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm])
    await $.session.start(start)
    await $.turn.complete(answer())
    const before = w.state().lastActivityAtEpoch
    w.setAgents([{ status: 'running', id: 'sub1' }])
    w.onFork(async () => {
      for await (const _ of $.turn.step(step())) { /* the ping's own, no agentId */ }
      await $.turn.complete(answer())
      await $.turn.complete(answer({ agentId: 'sub1' } as never)) // real subagent work, mid-ping
    })
    await clock.advance(51 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.state().lastActivityAtEpoch).toBeGreaterThan(before)
    expect(w.state().lastActivityAtEpoch).toBeGreaterThanOrEqual(w.state().lastPingAtEpoch)
  })

  test('a fork whose events carry an agentId no list names does not count as activity', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(start)
    await $.turn.complete(answer())
    const before = w.state().lastActivityAtEpoch
    w.onFork(async () => { await $.turn.complete(answer({ agentId: 'engine-fork-1' } as never)) })
    await clock.advance(51 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.state().lastActivityAtEpoch).toBe(before)
  })

  test('/clear during a slow ping: the old answer is discarded and the new session pings on schedule', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm])
    await $.session.start(start)
    await $.turn.complete(answer())
    let release: () => void = () => {}
    w.onFork(() => new Promise<void>(res => { release = res }))
    await clock.advance(51 * MIN)
    expect(w.forks.length).toBe(1) // ping 1 is out, unresolved
    w.onFork(async () => {})
    await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } } as never)
    w.setSid('S2')
    expect((await $.prompt.submit(say('fresh', composer))).drop).toBe(undefined)
    release()
    await clock.advance(1000)
    expect(w.state('S2').lastPing).toBe(null)
    expect(w.state('S2').refusals).toBe(0)
    await $.turn.complete(answer())
    await clock.advance(51 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.state('S2').lastPing.ok).toBe(true)
  })

  test('a failed removal of the error file keeps the flag and the next write retries', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(start)
    w.fail.mv = true
    await $.turn.complete(answer())
    expect([...w.files.keys()].some(k => k.endsWith('.error.json'))).toBe(true)
    w.fail.mv = false
    w.fail.rmErr = true
    await $.turn.complete(answer())
    expect([...w.files.keys()].some(k => k.endsWith('.error.json'))).toBe(true) // the delete failed: still there
    expect(w.logs.some(l => /could not remove the old error file/.test(l))).toBe(true)
    w.fail.rmErr = false
    await $.turn.complete(answer())
    expect([...w.files.keys()].some(k => k.endsWith('.error.json'))).toBe(false) // retried and gone
    void clock
  })
})
