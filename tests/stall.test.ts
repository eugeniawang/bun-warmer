import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { On, PromptOrigin, TurnStepInput } from 'claude-code'

tier('user')

const MIN = 60 * 1000
const START = 1_800_000_000_000

type Agent = { id: string; description: string; type: string; status: string }

function world(on: On, env: Record<string, string> = {}, submit: 'ok' | 'drop' | 'throw' | 'hold' = 'ok') {
  const files = new Map<string, string>()
  const finals = new Map<string, string>()
  const status: Array<string | undefined> = []
  const sent: Array<{ text: string; origin: PromptOrigin }> = []
  let agents: Agent[] = []
  // These tests predate quiet hours and run at an arbitrary hour of the machine's day: quiet hours stay off unless a test sets them. tests/quiet.test.ts covers them.
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/t' : env[e.name] ?? (e.name === 'BUN_WARMER_QUIET_HOURS' ? 'off' : undefined) }))
  on('fs.write', ($, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('process.run', ($, e) => {
    const [cmd, , from, to] = e.argv
    if (cmd === 'mv') { finals.set(to, files.get(from) ?? ''); files.delete(from) }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  let sid = 'S1'
  on('session.id', () => ({ value: sid }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  on('session.usage', () => ({ value: { startedAt: START, context: { window: 1000000, tokens: 1000 }, rateLimits: [] } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('agent.list', () => ({ value: agents as never }))
  on('ui.status', ($, e) => { status.push(e.text); return { value: undefined } })
  const logs: string[] = []
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.step', async function* ($, e) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never })
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  let gate: () => void = () => {}
  const held = new Promise<void>(res => { gate = res })
  on('prompt.submit', async ($, e) => {
    if (submit === 'hold') await held
    sent.push({ text: e.text, origin: e.origin })
    if (submit === 'throw') throw new Error('no route')
    if (submit === 'drop') return { drop: 'refused' }
    return { text: e.text }
  })
  return {
    sent, status, logs, setSid: (id: string) => { sid = id }, release: () => gate(),
    state: () => JSON.parse(finals.get('/home/t/.claude/bun-warmer/S1.json') ?? 'null') as Record<string, any>,
    setAgents: (a: Agent[]) => { agents = a },
  }
}

const start = { surface: null, isInteractive: false, cwd: '/work' } as const
const sub = (status = 'running'): Agent => ({ id: 'a1', description: 'build thing', type: 'general-purpose', status })
const step = (over: Partial<TurnStepInput> = {}) => ({ turnId: 't1', index: 0, model: 'm', messageCount: 3, ...over }) as TurnStepInput
const drain = async (it: AsyncIterable<unknown>) => { for await (const _ of it) { /* drain */ } }

describe('stall watchdog', () => {
  test('flags a running agent only after the threshold, not before', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start(start)
    w.setAgents([sub()])
    await clock.advance(5 * MIN) // first sighting sets the baseline
    await clock.advance(15 * MIN) // 15 minutes silent at the 20-minute check boundary minus one check
    expect(w.state()?.stalledAgents ?? []).toEqual([])
    await clock.advance(10 * MIN)
    const st = w.state().stalledAgents
    expect(st.length).toBe(1)
    expect(st[0].id).toBe('a1')
    expect(st[0].description).toBe('build thing')
    expect(st[0].type).toBe('general-purpose')
    expect(st[0].minutesSilent).toBeGreaterThanOrEqual(20)
    expect(st[0].firstFlaggedAt).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(w.status.at(-1)).toMatch(/STALLED: a1 \d+m/)
    expect(w.status.at(-1)).not.toContain('build thing')
  })

  test('sends one message per stall through $.prompt.submit, as a plugin origin', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start(start)
    w.setAgents([sub()])
    await clock.advance(60 * MIN)
    expect(w.sent.length).toBe(1)
    expect(w.sent[0].text).toMatch(/^Bun Warmer notice sent at \d\d:\d\d local time, ignore if you have since run \/bunwarm off or the subagent already finished\. A subagent of type general-purpose with id a1 had shown running but silent for \d+ minutes at that time\. Look it up by that id in your own Agent list\. Suggested, non-destructive: .*do not stop or respawn it on this notice alone\.$/)
    expect(w.sent[0].origin.kind).toBe('plugin')
    expect(w.state().stalledAgents[0].messageSent).toBe(true)
  })

  test('clears when the agent produces events again, and again when it ends', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start(start)
    w.setAgents([sub()])
    await clock.advance(30 * MIN)
    expect(w.state().stalledAgents.length).toBe(1)
    await drain($.turn.step(step({ agentId: 'a1' })))
    await clock.advance(5 * MIN)
    expect(w.state().stalledAgents).toEqual([])
    expect(w.status.at(-1) ?? '').not.toMatch(/STALLED/)
    await clock.advance(25 * MIN)
    expect(w.state().stalledAgents.length).toBe(1)
    expect(w.sent.length).toBe(2) // a new stall after resuming is a new report
    w.setAgents([sub('completed')])
    await clock.advance(5 * MIN)
    expect(w.state().stalledAgents).toEqual([])
  })

  test('events from a running agent reset the stall clock', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start(start)
    w.setAgents([sub()])
    for (let i = 0; i < 6; i++) {
      await clock.advance(10 * MIN)
      await drain($.turn.step(step({ agentId: 'a1' })))
    }
    expect(w.sent.length).toBe(0)
    expect(w.state().stalledAgents ?? []).toEqual([])
  })

  test('a real long tool call: no stall while it is in flight past the threshold, activity marked on completion, then a true stall is flagged', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on)
    let release: () => void = () => {}
    on('tool.call', () => new Promise(res => { release = () => res({ result: 'done', text: 'done' } as never) }))
    await $.session.start(start)
    w.setAgents([sub()])
    const call = ($.tool.call as (i: unknown) => Promise<unknown>)({ tool: 'Bash', command: 'make', agentId: 'a1' })
    await clock.advance(45 * MIN) // more than twice the 20-minute threshold, with no events at all
    expect(w.sent.length).toBe(0)
    expect(w.state().stalledAgents ?? []).toEqual([])
    release()
    await call
    await clock.advance(10 * MIN) // the completion restarted the clock: 10 minutes is under the threshold
    expect(w.sent.length).toBe(0)
    await clock.advance(25 * MIN) // running, no events, no tool in flight
    expect(w.sent.length).toBe(1)
    expect(w.state().stalledAgents[0].id).toBe('a1')
  })

  test('a true stall: running, no events, no tool in flight is flagged', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start(start)
    w.setAgents([sub()])
    await clock.advance(40 * MIN)
    expect(w.sent.length).toBe(1)
    expect(w.state().stalledAgents.length).toBe(1)
  })

  test('/bunwarm off stops the watchdog: no message and no stall record afterwards', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start(start)
    w.setAgents([sub()])
    await $.command.run({ command: 'bunwarm', args: 'off', origin: { kind: 'composer' } } as never)
    expect(w.state().armed).toBe(false)
    await clock.advance(3 * 60 * MIN)
    expect(w.sent.length).toBe(0)
    expect(w.state().stalledAgents).toEqual([])
  })

  test('window expiry stops the watchdog', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, { BUN_WARMER_WINDOW_HOURS: '1' })
    await $.session.start(start)
    await clock.advance(70 * MIN) // expired, no agents yet
    expect(w.state().armed).toBe(false)
    w.setAgents([sub()])
    await clock.advance(2 * 60 * MIN)
    expect(w.sent.length).toBe(0)
  })

  test('only running agents are flagged', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start(start)
    w.setAgents([sub('waiting'), { ...sub('idle'), id: 'a2' }, { ...sub('pending'), id: 'a3' }])
    await clock.advance(60 * MIN)
    expect(w.sent.length).toBe(0)
  })

  test('no message when the route is unavailable, and the stall is still recorded and shown', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, {}, 'drop')
    await $.session.start(start)
    w.setAgents([sub()])
    await clock.advance(30 * MIN)
    expect(w.state().stalledAgents[0].messageSent).toBe(false)
    expect(w.status.at(-1)).toMatch(/STALLED/)
  })

  test('the thresholds come from the environment', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, { BUN_WARMER_STALL_MIN: '1', BUN_WARMER_STALL_CHECK_MIN: '1' })
    await $.session.start(start)
    w.setAgents([sub()])
    await clock.advance(3 * MIN)
    expect(w.state().stalledAgents.length).toBe(1)
    expect(w.state().stallMin).toBe(1)
    expect(w.state().stallCheckMin).toBe(1)
    expect(w.sent.length).toBe(1)
  })
  test('/clear while a message is pending: the next stall of the old session is not sent into the new one', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, {}, 'hold')
    await $.session.start(start)
    w.setAgents([sub(), { ...sub(), id: 'a2', description: 'second thing' }])
    await clock.advance(25 * MIN) // both flagged; message 1 is stuck in the 15 s race
    await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } } as never)
    w.setSid('S2')
    const fresh = $.prompt.submit({ text: 'fresh', wait: false, origin: { kind: 'composer' } } as never) // a new session arms again
    await clock.advance(1000)
    w.release()
    await fresh
    await clock.advance(1 * MIN) // the 15 s race ends; the old loop must stop, not message about a2
    expect(w.sent.filter(m => /second thing/.test(m.text)).length).toBe(0)
  })

  test('our own stall message is dropped at prompt.submit when the mod is off', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start(start)
    await $.command.run({ command: 'bunwarm', args: 'off', origin: { kind: 'composer' } } as never)
    const r = await $.prompt.submit({ text: 'Bun Warmer notice sent at 10:00 local time, ignore if you have since run /bunwarm off or the subagent already finished. Subagent x (a1) had shown running but silent for 20 minutes at that time.', wait: false, origin: { kind: 'plugin', name: 'bun-warmer' } } as never)
    expect(r.drop).toBeDefined()
    expect(w.sent.length).toBe(0)
    void clock
  })
})
