import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { ModelForkResult, On, PromptOrigin, TurnCompleteInput, TurnStepInput } from 'claude-code'

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
  let agents: Array<{ status: string }> = []
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/t' : env[e.name] }))
  on('fs.write', ($, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('process.run', ($, e) => {
    const [cmd, , from, to] = e.argv
    if (cmd === 'mv') { finals.set(to, files.get(from) ?? ''); files.delete(from) }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'S1' }))
  on('session.usage', () => ({ value: { startedAt: START, context: { window: 1000000, tokens: 200000 }, rateLimits: [] } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('agent.list', () => ({ value: agents as never }))
  on('ui.status', ($, e) => { status.push(e.text); return { value: undefined } })
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => { prompts.push(e.text); return { text: e.text } })
  on('turn.step', async function* ($, e) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never })
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('model.fork', () => {
    forks.push(forks.length)
    const a = forkAnswers.shift()
    if (a === undefined) return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as unknown as ModelForkResult }
    if ('isAnswered' in a) return { value: a }
    return { value: { isAnswered: true, text: 'warm', usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: a.read, cache_creation_input_tokens: a.write } } as ModelForkResult }
  })
  return {
    forks, status, logs, prompts,
    state: () => JSON.parse(finals.get('/home/t/.claude/bun-warmer/S1.json') ?? 'null') as Record<string, any>,
    setAgents: (a: Array<{ status: string }>) => { agents = a },
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
    const w = world(on, [warm, warm])
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
    expect(st.expiresAtEpoch).toBe(Math.floor((START + 3 * HOUR) / 1000))
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

  test('a cold session passes every non-human prompt through, even in refuse mode', async ($, on) => {
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
})
