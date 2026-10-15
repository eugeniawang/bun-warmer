import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { ModelForkResult, On, PromptOrigin, TurnCompleteInput, TurnStepInput } from 'claude-code'

import { hourSetting, inActiveHours, nextActiveMoment, quietHoursOff } from '../hooks/register'

tier('user')

const MIN = 60 * 1000
const HOUR = 60 * MIN

// Every time here is built from LOCAL calendar fields and read back with the local getters, as the mod does,
// so the suite holds in any machine zone (run it under TZ=America/Los_Angeles, UTC and Asia/Kolkata).
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime()
const hourOf = (ms: number) => new Date(ms).getHours()
const OCT14_07 = at(2026, 10, 14, 7)

type Clock = ReturnType<typeof mock.clock>

function world(on: On, clock: Clock, env: Record<string, string> = {}) {
  const files = new Map<string, string>()
  const finals = new Map<string, string>()
  const pingTimes: number[] = []
  const status: Array<string | undefined> = []
  let sid = 'S1'
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/t' : env[e.name] }))
  on('fs.write', ($, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('process.run', ($, e) => {
    const [cmd, , from, to] = e.argv
    if (cmd === 'mv') { finals.set(to, files.get(from) ?? ''); files.delete(from) }
    if (cmd === 'rm') { files.delete(from); finals.delete(from) }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: sid }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'hi', toolUses: [] }] as never }))
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] as never }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000, tokens: 200000 }, rateLimits: [] } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('agent.list', () => ({ value: [] as never }))
  on('ui.status', ($, e) => { status.push(e.text); return { value: undefined } })
  on('ui.log', () => ({ value: undefined }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.step', async function* ($, e) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never })
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('model.fork', async () => {
    pingTimes.push(clock.now())
    return { value: { isAnswered: true, text: 'warm', usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 200000, cache_creation_input_tokens: 10 } } as ModelForkResult }
  })
  return {
    pingTimes, status,
    setSid: (id: string) => { sid = id },
    state: (id = 'S1') => JSON.parse(finals.get(`/home/t/.claude/bun-warmer/${id}.json`) ?? 'null') as Record<string, any>,
  }
}

const start = { surface: null, isInteractive: false, cwd: '/work' } as const
const composer: PromptOrigin = { kind: 'composer' }
const answer = (over: Partial<TurnCompleteInput> = {}) => ({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer', ...over }) as TurnCompleteInput
const step = (over: Partial<TurnStepInput> = {}) => ({ turnId: 't1', index: 0, model: 'm', messageCount: 3, ...over }) as TurnStepInput
const say = (text: string, origin: PromptOrigin) => ({ text, wait: false, origin })

describe('quiet hours: the pure rules', () => {
  test('a daytime range is [start, end): 06:00 in, 22:59 in, 23:00 out, 05:59 out', () => {
    expect(inActiveHours(at(2026, 10, 14, 6, 0), 6, 23)).toBe(true)
    expect(inActiveHours(at(2026, 10, 14, 22, 59), 6, 23)).toBe(true)
    expect(inActiveHours(at(2026, 10, 14, 23, 0), 6, 23)).toBe(false)
    expect(inActiveHours(at(2026, 10, 15, 5, 59), 6, 23)).toBe(false)
  })

  test('an overnight range wraps midnight (22 to 6)', () => {
    for (const [h, want] of [[21, false], [22, true], [23, true], [0, true], [5, true], [6, false], [12, false]] as const) {
      expect(inActiveHours(at(2026, 10, 14, h, 30), 22, 6)).toBe(want)
    }
  })

  test('start equal to end means no restriction', () => {
    expect(inActiveHours(at(2026, 10, 14, 3, 0), 6, 6)).toBe(true)
    expect(inActiveHours(at(2026, 10, 14, 15, 0), 0, 0)).toBe(true)
  })

  test('the next active moment is the next local start hour, or now when already active', () => {
    const noon = at(2026, 10, 14, 12)
    expect(nextActiveMoment(noon, 6, 23)).toBe(noon)
    expect(nextActiveMoment(at(2026, 10, 14, 23, 10), 6, 23)).toBe(at(2026, 10, 15, 6))
    expect(nextActiveMoment(at(2026, 10, 15, 2, 0), 6, 23)).toBe(at(2026, 10, 15, 6))
    expect(nextActiveMoment(at(2026, 10, 14, 10, 0), 22, 6)).toBe(at(2026, 10, 14, 22))
  })

  test('across a DST change the next active moment still lands on the start hour of the wall clock', () => {
    // US spring forward (2026-03-08) and fall back (2026-11-01). In a zone with no DST these are ordinary days and the same checks hold.
    for (const [m, d] of [[3, 8], [11, 1]] as const) {
      const t = nextActiveMoment(at(2026, m, d, 0, 30), 3, 5)
      expect(hourOf(t)).toBe(3)
      expect(t).toBeGreaterThan(at(2026, m, d, 0, 30))
      // 2:00 is skipped on the spring-forward night, so the wall-clock hour 3 is 2h30 or 3h30 away, never a day away.
      expect(t - at(2026, m, d, 0, 30)).toBeLessThanOrEqual(4 * HOUR)
    }
    const spring = nextActiveMoment(at(2026, 3, 8, 0, 30), 2, 5)
    expect(hourOf(spring)).toBeGreaterThanOrEqual(2)
    expect(hourOf(spring)).toBeLessThan(5)
  })

  test('settings parse: only whole hours 0-23 count, only the word off disables', () => {
    expect(hourSetting('7', 6)).toBe(7)
    expect(hourSetting(' 0 ', 6)).toBe(0)
    expect(hourSetting('23', 6)).toBe(23)
    for (const bad of ['24', '-1', '6.5', 'six', '', undefined]) expect(hourSetting(bad, 6)).toBe(6)
    expect(quietHoursOff('off')).toBe(true)
    expect(quietHoursOff(' OFF ')).toBe(true)
    for (const no of ['on', '', '0', 'false', undefined]) expect(quietHoursOff(no)).toBe(false)
  })
})

describe('quiet hours: the schedule', () => {
  test('a session started at 07:00 and left idle stops pinging 3 hours after its last activity, not at 23:00', async ($, on) => {
    const clock = mock.clock(on, { now: OCT14_07 })
    const w = world(on, clock)
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(17 * HOUR) // on to midnight, well past 23:00
    expect(w.pingTimes.map(t => new Date(t).toTimeString().slice(0, 5))).toEqual(['07:50', '08:40', '09:30'])
    for (const t of w.pingTimes) expect(t).toBeLessThanOrEqual(at(2026, 10, 14, 10, 0))
    expect(w.state().armed).toBe(false)
    expect(w.state().note).toBe('window expired')
    expect(w.state().skippedQuiet).toBe(0)
    expect(w.state().expiresAtEpoch).toBe(Math.floor(at(2026, 10, 14, 10, 0) / 1000))
  })

  test('a ping never extends the window: expiresAt stays where the last real activity put it', async ($, on) => {
    const clock = mock.clock(on, { now: OCT14_07 })
    const w = world(on, clock)
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(100 * MIN)
    expect(w.pingTimes.length).toBe(2)
    expect(w.state().expiresAtEpoch).toBe(Math.floor(at(2026, 10, 14, 10, 0) / 1000))
    expect(w.state().lastActivityAtEpoch).toBe(Math.floor(OCT14_07 / 1000))
  })

  test('a window that crosses 23:00: the ping due after 23:00 is skipped and recorded, not failed, and nothing pings overnight', async ($, on) => {
    const clock = mock.clock(on, { now: at(2026, 10, 14, 21, 30) })
    const w = world(on, clock, { BUN_WARMER_WINDOW_HOURS: '6' })
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(51 * MIN) // 22:21: the 22:20 ping is out
    expect(w.pingTimes.length).toBe(1)
    await clock.advance(50 * MIN) // 23:11: the 23:10 ping is due in quiet hours
    expect(w.pingTimes.length).toBe(1)
    const st = w.state()
    expect(st.skippedQuiet).toBe(1)
    expect(new Date(st.lastSkippedAtEpoch * 1000).toTimeString().slice(0, 5)).toBe('23:10')
    expect(st.refusals).toBe(0)
    expect(st.lastPing.ok).toBe(true)
    expect(st.armed).toBe(true)
    expect(st.expiresAtEpoch).toBe(Math.floor(at(2026, 10, 15, 3, 30) / 1000)) // the window end, untouched by the skip
    expect(w.status.at(-1)).toContain('quiet hours')
    await clock.advance(5 * HOUR) // 04:11, window still open
    expect(w.pingTimes.length).toBe(1)
  })

  test('at 06:00 the window is still open but the cache has gone cold, so nothing is pinged; typed activity restarts it', async ($, on) => {
    const clock = mock.clock(on, { now: at(2026, 10, 14, 21, 30) })
    const w = world(on, clock, { BUN_WARMER_WINDOW_HOURS: '12', BUN_WARMER_MAX_HOURS: '24' })
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(8.6 * HOUR + 10 * MIN) // 06:16 next morning
    expect(w.pingTimes.length).toBe(1)
    expect(w.state().armed).toBe(true)
    await $.prompt.submit(say('good morning', composer))
    await clock.advance(51 * MIN)
    expect(w.pingTimes.length).toBe(2)
    expect(hourOf(w.pingTimes[1])).toBe(7)
  })

  test('resume at 06:00 only when the window is open and the cache is warm: subagent work at 05:30 gets a 06:20 ping', async ($, on) => {
    const clock = mock.clock(on, { now: at(2026, 10, 14, 21, 30) })
    const w = world(on, clock, { BUN_WARMER_WINDOW_HOURS: '12', BUN_WARMER_MAX_HOURS: '24' })
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.set(at(2026, 10, 15, 5, 30))
    for await (const _ of $.turn.step(step({ agentId: 'sub1' }))) { /* drain */ }
    const before = w.pingTimes.length
    await clock.advance(49 * MIN) // 06:19: due 06:20 not yet
    expect(w.pingTimes.length).toBe(before)
    await clock.advance(2 * MIN) // 06:21
    expect(w.pingTimes.length).toBe(before + 1)
    expect(new Date(w.pingTimes.at(-1)!).toTimeString().slice(0, 5)).toBe('06:20')
    // subagent work does not extend a window that has run out: the window is 12h from the typed prompt at 21:30
    expect(w.state().expiresAtEpoch).toBe(Math.floor(at(2026, 10, 15, 9, 30) / 1000))
  })

  test('subagent activity still extends the window', async ($, on) => {
    const clock = mock.clock(on, { now: OCT14_07 })
    const w = world(on, clock)
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(2.5 * HOUR)
    for await (const _ of $.turn.step(step({ agentId: 'sub1' }))) { /* drain */ }
    await clock.advance(31 * MIN) // 10:01: past the original window end, but a subagent was active at 09:30
    expect(w.state().armed).toBe(true)
    await clock.advance(HOUR) // 11:01
    expect(w.pingTimes.some(t => t > at(2026, 10, 14, 10, 0))).toBe(true)
  })

  test('BUN_WARMER_QUIET_HOURS=off pings around the clock, within the window', async ($, on) => {
    const clock = mock.clock(on, { now: at(2026, 10, 14, 21) })
    const w = world(on, clock, { BUN_WARMER_QUIET_HOURS: 'off', BUN_WARMER_WINDOW_HOURS: '6' })
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(10 * HOUR)
    const hours = w.pingTimes.map(hourOf)
    expect(hours).toContain(23)
    expect(hours).toContain(0)
    expect(hours).toContain(1)
    expect(w.state().skippedQuiet).toBe(0)
    expect(w.state().quietHours.enabled).toBe(false)
    for (const t of w.pingTimes) expect(t).toBeLessThanOrEqual(at(2026, 10, 15, 3, 0))
    expect(w.state().armed).toBe(false)
  })

  test('start and end hours come from the environment, wrap midnight, and bad values fall back to 6 and 23', async ($, on) => {
    const clock = mock.clock(on, { now: at(2026, 10, 14, 22) })
    const w = world(on, clock, { BUN_WARMER_ACTIVE_START: '22', BUN_WARMER_ACTIVE_END: '6', BUN_WARMER_WINDOW_HOURS: '4' })
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(4 * HOUR + 10 * MIN)
    expect(w.pingTimes.map(hourOf)).toEqual([22, 23, 0, 1].slice(0, w.pingTimes.length))
    expect(w.pingTimes.length).toBeGreaterThanOrEqual(4)
    expect(w.state().skippedQuiet).toBe(0)
    expect(w.state().quietHours).toEqual({ enabled: true, activeStartHour: 22, activeEndHour: 6 })
  })

  test('invalid hour settings fall back to the defaults', async ($, on) => {
    const clock = mock.clock(on, { now: OCT14_07 })
    const w = world(on, clock, { BUN_WARMER_ACTIVE_START: '25', BUN_WARMER_ACTIVE_END: 'late' })
    await $.session.start(start)
    expect(w.state().quietHours).toEqual({ enabled: true, activeStartHour: 6, activeEndHour: 23 })
  })

  test('over a DST night every ping lands in active hours and skips are recorded', async ($, on) => {
    // 2026-11-01 is the US fall-back night (01:00 repeats); in a zone with no DST it is an ordinary night and the same holds.
    const clock = mock.clock(on, { now: at(2026, 10, 31, 22) })
    const w = world(on, clock, { BUN_WARMER_ACTIVE_START: '2', BUN_WARMER_ACTIVE_END: '4', BUN_WARMER_INTERVAL_MIN: '10', BUN_WARMER_WINDOW_HOURS: '12', BUN_WARMER_MAX_HOURS: '24' })
    await $.session.start(start)
    await $.turn.complete(answer())
    for (let i = 0; i < 8; i++) {
      await clock.advance(55 * MIN)
      for await (const _ of $.turn.step(step({ agentId: 'sub1' }))) { /* drain */ }
    }
    await clock.advance(55 * MIN)
    expect(w.pingTimes.length).toBeGreaterThan(0)
    for (const t of w.pingTimes) expect([2, 3]).toContain(hourOf(t))
    expect(w.state().skippedQuiet).toBeGreaterThan(0)
  })
})

describe('quiet hours: what stays the same', () => {
  test('the guard is untouched: warn lets a cold send through at night', async ($, on) => {
    const clock = mock.clock(on, { now: at(2026, 10, 14, 21, 30) })
    const w = world(on, clock, { BUN_WARMER_WINDOW_HOURS: '6' })
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(5 * HOUR) // 02:30, cache cold
    const r = await $.prompt.submit(say('hello again', composer))
    expect(r.drop).toBe(undefined)
    expect(w.state().guardDrops).toBe(0)
  })

  test('the guard is untouched: refuse still drops the first cold send once, at night', { options: { guard: 'refuse' } }, async ($, on) => {
    const clock = mock.clock(on, { now: at(2026, 10, 14, 21, 30) })
    const w = world(on, clock, { BUN_WARMER_WINDOW_HOURS: '6' })
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(5 * HOUR)
    expect((await $.prompt.submit(say('hello again', composer))).drop).toBeTruthy()
    expect((await $.prompt.submit(say('hello again', composer))).drop).toBe(undefined)
    expect(w.state().guardDrops).toBe(1)
  })

  test('/clear starts a clean session (skips back to 0) and the quiet-hours setting carries over', async ($, on) => {
    const clock = mock.clock(on, { now: at(2026, 10, 14, 22, 30) })
    const w = world(on, clock)
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(51 * MIN) // 23:21: the 23:20 ping was skipped
    expect(w.state().skippedQuiet).toBe(1)
    await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } } as never)
    w.setSid('S2')
    await $.prompt.submit(say('fresh start', composer)) // 23:21, quiet
    await clock.advance(51 * MIN) // 00:12: ping due 00:11, quiet again
    expect(w.pingTimes.length).toBe(0)
    expect(w.state('S2').skippedQuiet).toBe(1)
    expect(w.state('S2').quietHours.enabled).toBe(true)
  })

  test('compaction leaves the quiet-hours record alone', async ($, on) => {
    const clock = mock.clock(on, { now: at(2026, 10, 14, 22, 30) })
    const w = world(on, clock)
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(51 * MIN)
    expect(w.state().skippedQuiet).toBe(1)
    await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'long history', toolUses: [] }] })
    expect(w.state().skippedQuiet).toBe(1)
    expect(w.state().refusals).toBe(0)
  })
})
