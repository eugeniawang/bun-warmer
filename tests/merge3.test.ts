import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { On, TurnCompleteInput } from 'claude-code'

tier('user')

const MIN = 60 * 1000
const START = 1_800_000_000_000

/** Pings answer in turn from `replies`: 'warm' finds the cache warm, 'error' is an API failure. */
function world(on: On, replies: Array<'warm' | 'error'>) {
  const files = new Map<string, string>()
  const finals = new Map<string, string>()
  let n = 0
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/t' : e.name === 'BUN_WARMER_QUIET_HOURS' ? 'off' : undefined }))
  on('fs.write', ($, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('process.run', ($, e) => {
    if (e.argv[0] === 'mv') { finals.set(e.argv[3], files.get(e.argv[2]) ?? ''); files.delete(e.argv[2]) }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'S1' }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  on('session.usage', () => ({ value: { startedAt: START, context: { window: 1000000, tokens: 200000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 10 }] } as never }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('agent.list', () => ({ value: [] as never }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('model.fork', async () => {
    const r = replies[n++] ?? 'error'
    if (r === 'error') return { value: { isAnswered: false, reason: 'api-error', status: 500, error: 'api_error' } as never }
    return { value: { isAnswered: true, text: 'warm', usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 200000, cache_creation_input_tokens: 10 } } as never }
  })
  return { state: () => JSON.parse(finals.get('/home/t/.claude/bun-warmer/S1.json') ?? 'null') as Record<string, any> }
}

const start = { surface: null, isInteractive: false, cwd: '/work' } as const
const answer = () => ({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' }) as TurnCompleteInput

describe('the state file carries what the hook judges warm or cold from', () => {
  test('lastWarmAtEpochMs is activity or the last ping that found the cache warm; a failed ping after it changes nothing', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, ['warm', 'error'])
    await $.session.start(start)
    await $.turn.complete(answer())
    expect(w.state().lastWarmAtEpochMs).toBe(START)
    await clock.advance(51 * MIN) // good ping at +50
    expect(w.state().lastWarmAtEpochMs).toBe(START + 50 * MIN)
    await clock.advance(50 * MIN) // failed ping at +100
    expect(w.state().lastPing.ok).toBe(false)
    expect(w.state().lastWarmAtEpochMs).toBe(START + 50 * MIN)
    expect(w.state().statusState).toBe('warm')
  })

  test('millisecond expiry and next-ping times, so a reader rounds exactly as the hook does', async ($, on) => {
    const clock = mock.clock(on, { now: START + 123 })
    const w = world(on, [])
    await $.session.start(start)
    await $.turn.complete(answer())
    expect(w.state().expiresAtEpochMs).toBe(START + 123 + 180 * MIN)
    expect(w.state().nextPingAtEpochMs).toBe(START + 123 + 50 * MIN)
    void clock
  })
})
