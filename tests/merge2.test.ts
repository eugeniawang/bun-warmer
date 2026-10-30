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
type Disk = Map<string, { text: string; mtimeMs: number; kind: Entry['kind']; isLink: boolean }>

/** opts.disk: the files in ~/.claude/bun-warmer, by full path. opts.onMove runs after each cleanup move (a session writing in the gap). */
function world(on: On, opts: { env?: Record<string, string>; disk?: Disk; onMove?: (disk: Disk, from: string, to: string) => void; cacheGone?: boolean } = {}) {
  const env = { BUN_WARMER_QUIET_HOURS: 'off', ...(opts.env ?? {}) }
  const finals = new Map<string, string>()
  const files = new Map<string, string>()
  const removed: string[] = []
  const sent: string[] = []
  const forks: number[] = []
  let agents: Agent[] = []
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/t' : env[e.name as keyof typeof env] }))
  on('fs.write', ($, e) => { files.set(e.path, e.text); return { value: undefined } })
  const disk = opts.disk
  const ok = (exitCode = 0) => ({ value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('fs.list', ($, e) => {
    if (!disk) throw new Error('no dir')
    return { value: [...disk].filter(([p]) => p.startsWith(e.path + '/')).map(([p, f]) => ({ name: p.slice(e.path.length + 1), kind: f.isLink ? 'other' : f.kind, size: f.text.length, mtimeMs: f.mtimeMs, isLink: f.isLink })) as never }
  })
  on('fs.stat', ($, e) => { const f = disk?.get(e.path); if (!f) throw new Error('missing'); return { value: { kind: f.kind, size: f.text.length, mtimeMs: f.mtimeMs, isLink: f.isLink } as never } })
  on('fs.read', ($, e) => { const f = disk?.get(e.path); if (!f) throw new Error('missing'); return { value: f.text as never } })
  on('process.run', ($, e) => {
    const a = e.argv
    if (a[0] === 'mv' && a[1] === '-n' && a[2] === '--' && disk) {
      const [from, to] = [a[3], a[4]]
      if (!disk.has(from) || disk.has(to)) return ok(1)
      disk.set(to, disk.get(from)!); disk.delete(from)
      opts.onMove?.(disk, from, to)
      return ok()
    }
    if (a[0] === 'mv') { finals.set(a[3], files.get(a[2]) ?? ''); files.delete(a[2]); return ok() }
    if (a[0] === 'rm' && a.includes('--')) { const p = a[a.length - 1]; removed.push(p); disk?.delete(p) }
    return ok()
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
    removed, sent, forks, disk,
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
    expect(cleanupTargets([f('.bwclean-abc-old-off.json', 400)], now, 30, 'S1.json')).toEqual({ check: [], remove: [] })
  })

  test('keep days 0 deletes nothing', () => {
    expect(cleanupTargets([f('old-off.json', 400), f('.x.json.tmp', 9)], now, 0, 'S1.json')).toEqual({ check: [], remove: [] })
  })

  const D = '/home/t/.claude/bun-warmer'
  const on_ = (text: string, ageDays: number, kind: Entry['kind'] = 'file', isLink = false) => ({ text, mtimeMs: now - ageDays * DAY, kind, isLink })
  const off = JSON.stringify({ armed: false })
  const names = (d: Disk) => [...d.keys()].map(p => p.slice(D.length + 1)).sort()

  test('at session start it removes an old disarmed file and an old temp file, and keeps an armed one and an unreadable one', async ($, on) => {
    const clock = mock.clock(on, { now })
    const disk: Disk = new Map([
      [`${D}/old-off.json`, on_(off, 40)], [`${D}/old-on.json`, on_(JSON.stringify({ armed: true }), 40)],
      [`${D}/bad.json`, on_('{not json', 40)], [`${D}/.x.json.tmp`, on_('', 2)],
    ])
    const w = world(on, { disk })
    await $.session.start(start)
    await clock.settle()
    expect(names(disk)).toEqual(['bad.json', 'old-on.json'])
  })

  test('a disarmed file rewritten as armed before cleanup reaches it is kept', async ($, on) => {
    const clock = mock.clock(on, { now })
    const disk: Disk = new Map([[`${D}/old-off.json`, on_(off, 40)]])
    const w = world(on, { disk })
    disk.set(`${D}/old-off.json`, on_(JSON.stringify({ armed: true }), 0))
    await $.session.start(start)
    await clock.settle()
    expect(names(disk)).toEqual(['old-off.json'])
    expect(JSON.parse(disk.get(`${D}/old-off.json`)!.text).armed).toBe(true)
    void w
  })

  test('a file that is no longer old when moved aside (rewritten in the gap) is put back, not deleted', async ($, on) => {
    const clock = mock.clock(on, { now })
    const disk: Disk = new Map([[`${D}/old-off.json`, on_(off, 40)]])
    let hit = false
    const w = world(on, { disk, onMove: (d, from, to) => { if (!hit && to.includes('.bwclean-')) { hit = true; d.set(to, on_(JSON.stringify({ armed: true }), 0)) } } })
    await $.session.start(start)
    await clock.settle()
    expect(names(disk)).toEqual(['old-off.json'])
    expect(JSON.parse(disk.get(`${D}/old-off.json`)!.text).armed).toBe(true)
    void w
  })

  test('a file swapped for a symlink after the listing is put back, not deleted', async ($, on) => {
    const clock = mock.clock(on, { now })
    const disk: Disk = new Map([[`${D}/old-off.json`, on_(off, 40)]])
    let swapped = false
    const w = world(on, { disk, onMove: (d, from, to) => { if (!swapped) { swapped = true; d.set(to, { ...d.get(to)!, isLink: true }) } } })
    await $.session.start(start)
    await clock.settle()
    expect(names(disk)).toEqual(['old-off.json'])
    void w
  })

  test('a fresh write that lands after the move is left alone and the old copy is removed', async ($, on) => {
    const clock = mock.clock(on, { now })
    const disk: Disk = new Map([[`${D}/old-off.json`, on_(off, 40)]])
    // The session's write lands after the move: its new file must stay, and the old moved-aside copy is the one removed.
    const w = world(on, { disk, onMove: (d, from) => { if (from.endsWith('/old-off.json')) d.set(from, on_(JSON.stringify({ armed: true }), 0)) } })
    await $.session.start(start)
    await clock.settle()
    expect(names(disk)).toEqual(['old-off.json'])
    expect(JSON.parse(disk.get(`${D}/old-off.json`)!.text).armed).toBe(true)
    void w
  })

  test('BUN_WARMER_KEEP_DAYS=0 removes nothing', async ($, on) => {
    const clock = mock.clock(on, { now })
    const disk: Disk = new Map([[`${D}/old-off.json`, on_(off, 400)]])
    const w = world(on, { env: { BUN_WARMER_KEEP_DAYS: '0' }, disk })
    await $.session.start(start)
    await clock.settle()
    expect(names(disk)).toEqual(['old-off.json'])
    void w
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
