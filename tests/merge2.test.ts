import { describe, expect, mock, test, tier } from 'claude-code/testing'
import { afterSleep, cleanupTargets } from '../hooks/register'
import type { On, PromptOrigin, TurnCompleteInput } from 'claude-code'

tier('user')

const MIN = 60 * 1000
const DAY = 24 * 60 * MIN
const START = 1_800_000_000_000

type Agent = { id: string; description: string; type: string; status: string }
type Entry = { name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean }

/** A session with a state folder the test fills, a record of every rm, and a prompt.submit record. */
function world(on: On, opts: { env?: Record<string, string>; dir?: Entry[]; contents?: Record<string, string>; cacheGone?: boolean } = {}) {
  const env = { BUN_WARMER_QUIET_HOURS: 'off', ...(opts.env ?? {}) }
  const finals = new Map<string, string>()
  const files = new Map<string, string>()
  const removed: string[] = []
  const sent: string[] = []
  const forks: number[] = []
  let agents: Agent[] = []
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/t' : env[e.name as keyof typeof env] }))
  on('fs.write', ($, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.list', ($, e) => { if (opts.dir === undefined) throw new Error('no dir'); return { value: opts.dir as never } })
  on('fs.read', ($, e) => { const t = opts.contents?.[e.path]; if (t === undefined) throw new Error('missing'); return { value: t as never } })
  on('process.run', ($, e) => {
    const [cmd, , from, to] = e.argv
    if (cmd === 'mv') { finals.set(to, files.get(from) ?? ''); files.delete(from) }
    if (cmd === 'rm' && e.argv.includes('--')) removed.push(e.argv[e.argv.length - 1])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'S1' }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  on('session.usage', () => ({ value: { startedAt: START, context: { window: 1000000, tokens: 200000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 10 }] } as never }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('agent.list', () => ({ value: agents as never }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => { sent.push(e.text); return { text: e.text } })
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('model.fork', async () => {
    forks.push(forks.length)
    const usage = opts.cacheGone
      ? { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }
      : { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 200000, cache_creation_input_tokens: 10 }
    return { value: { isAnswered: true, text: 'warm', usage } as never }
  })
  return {
    removed, sent, forks,
    setAgents: (a: Agent[]) => { agents = a },
    state: () => JSON.parse(finals.get('/home/t/.claude/bun-warmer/S1.json') ?? 'null') as Record<string, any>,
  }
}

const start = { surface: null, isInteractive: false, cwd: '/work' } as const
const sub = (): Agent => ({ id: 'a1', description: 'build thing', type: 'general-purpose', status: 'running' })
const answer = () => ({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' }) as TurnCompleteInput
const composer: PromptOrigin = { kind: 'composer' }

describe('stall prompt is opt-in', () => {
  test('by default a stalled subagent is flagged in the state file but no prompt is submitted', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on)
    await $.session.start(start)
    w.setAgents([sub()])
    await clock.advance(40 * MIN)
    expect(w.state().stalledAgents.length).toBe(1)
    expect(w.sent.length).toBe(0)
    expect(w.state().stallPrompt).toBe(false)
  })

  test('BUN_WARMER_STALL_PROMPT=on submits the one notice', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, { env: { BUN_WARMER_STALL_PROMPT: 'on' } })
    await $.session.start(start)
    w.setAgents([sub()])
    await clock.advance(40 * MIN)
    expect(w.sent.length).toBe(1)
    expect(w.state().stallPrompt).toBe(true)
  })
})

describe('post-wake grace', () => {
  test('a gap between stall checks longer than two check intervals is a sleep', () => {
    expect(afterSleep(0, START, 5 * MIN)).toBe(false) // first check
    expect(afterSleep(START, START + 5 * MIN, 5 * MIN)).toBe(false)
    expect(afterSleep(START, START + 10 * MIN, 5 * MIN)).toBe(false)
    expect(afterSleep(START, START + 11 * MIN, 5 * MIN)).toBe(true)
    expect(afterSleep(START, START + 3 * 60 * MIN, 5 * MIN)).toBe(true)
  })
})

describe('state-file cleanup', () => {
  const now = START
  const f = (name: string, ageDays: number, kind: Entry['kind'] = 'file'): Entry => ({ name, kind, size: 10, mtimeMs: now - ageDays * DAY, isLink: false })

  test('only disarmed files older than the keep period, and orphan temp files older than a day', () => {
    const entries = [f('old-off.json', 40), f('old-on.json', 40), f('new-off.json', 5), f('.x.json.tmp', 2), f('.y.json.tmp', 0.5), f('S1.json', 40), f('notes.txt', 400), f('sub', 400, 'dir'), f('link.json', 400, 'other'), f('old.error.json', 40)]
    const t = cleanupTargets(entries, now, 30, 'S1.json')
    expect(t.check.sort()).toEqual(['old-off.json', 'old-on.json'])
    expect(t.remove).toEqual(['.x.json.tmp'])
  })

  test('keep days 0 deletes nothing', () => {
    expect(cleanupTargets([f('old-off.json', 400), f('.x.json.tmp', 9)], now, 0, 'S1.json')).toEqual({ check: [], remove: [] })
  })

  test('at session start it removes an old disarmed file and an old temp file, and keeps an armed one and an unreadable one', async ($, on) => {
    const clock = mock.clock(on, { now })
    const D = '/home/t/.claude/bun-warmer'
    const w = world(on, {
      dir: [f('old-off.json', 40), f('old-on.json', 40), f('bad.json', 40), f('.x.json.tmp', 2)],
      contents: { [`${D}/old-off.json`]: JSON.stringify({ armed: false }), [`${D}/old-on.json`]: JSON.stringify({ armed: true }), [`${D}/bad.json`]: '{not json' },
    })
    await $.session.start(start)
    await clock.settle()
    expect(w.removed.sort()).toEqual([`${D}/.x.json.tmp`, `${D}/old-off.json`])
  })

  test('BUN_WARMER_KEEP_DAYS=0 removes nothing', async ($, on) => {
    mock.clock(on, { now })
    const D = '/home/t/.claude/bun-warmer'
    const w = world(on, { env: { BUN_WARMER_KEEP_DAYS: '0' }, dir: [f('old-off.json', 400)], contents: { [`${D}/old-off.json`]: JSON.stringify({ armed: false }) } })
    await $.session.start(start)
    expect(w.removed).toEqual([])
  })

  test('a folder that cannot be listed does not break session start', async ($, on) => {
    mock.clock(on, { now })
    const w = world(on)
    await $.session.start(start)
    expect(w.state().armed).toBe(true)
    expect(w.removed).toEqual([])
  })
})

describe('a ping that finds the cache gone', () => {
  test('keeps the resolved cacheTtl and records the stop separately', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, { cacheGone: true })
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(70 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.state().cacheTtl).toBe('1h')
    expect(w.state().pingsStopped).toBe(true)
    expect(w.state().statusText).toContain('found the cache gone')
    await $.prompt.submit({ text: 'hello', wait: false, origin: composer })
    await $.turn.complete(answer())
    await clock.advance(70 * MIN)
    expect(w.forks.length).toBe(1)
  })
})
