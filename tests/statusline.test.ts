import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { On, PromptOrigin, TurnCompleteInput } from 'claude-code'

tier('user')

const MIN = 60 * 1000
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime()

function world(on: On, env: Record<string, string> = {}) {
  const status: Array<string | undefined> = []
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/t' : env[e.name] }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'S1' }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'hi', toolUses: [] }] as never }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000, tokens: 200000 }, rateLimits: [] } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('agent.list', () => ({ value: [] as never }))
  on('ui.status', ($, e) => { status.push(e.text); return { value: undefined } })
  on('ui.log', () => ({ value: undefined }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('model.fork', async () => ({ value: { isAnswered: true, text: 'warm', usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 200000, cache_creation_input_tokens: 10 } } as never }))
  return { status }
}

const start = { surface: null, isInteractive: false, cwd: '/work' } as const
const answer = () => ({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' }) as TurnCompleteInput
void ({} as PromptOrigin)

describe('status line: state, time left, next ping', () => {
  test('before the first turn: idle, window left, no ping time', async ($, on) => {
    mock.clock(on, { now: at(2026, 10, 14, 10) })
    const w = world(on)
    await $.session.start(start)
    expect(w.status.at(-1)).toBe('bun-warmer · idle · 1h30m left · waiting for the first turn')
  })

  test('right after a turn: warm, window left, ping in the interval', async ($, on) => {
    mock.clock(on, { now: at(2026, 10, 14, 10) })
    const w = world(on)
    await $.session.start(start)
    await $.turn.complete(answer())
    expect(w.status.at(-1)).toBe('bun-warmer · warm · 1h30m left · ping in 50m')
  })

  test('a cache with no activity or ping for 60 minutes is cold', async ($, on) => {
    const clock = mock.clock(on, { now: at(2026, 10, 14, 21, 30) })
    const w = world(on, { BUN_WARMER_WINDOW_HOURS: '12', BUN_WARMER_MAX_HOURS: '24' })
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(8 * 60 * MIN + 1 * MIN) // 05:31 next day, then the 06:00 check
    await clock.advance(30 * MIN)
    expect(w.status.at(-1)).toMatch(/^bun-warmer · cold · /)
  })

  test('quiet hours: still a one-line status with state and time left', async ($, on) => {
    mock.clock(on, { now: at(2026, 10, 14, 22, 30) })
    const w = world(on, { BUN_WARMER_WINDOW_HOURS: '3' })
    await $.session.start(start)
    await $.turn.complete(answer())
    expect(w.status.at(-1)).toMatch(/^bun-warmer · warm · 3h00m left · /)
    expect(w.status.at(-1)).not.toContain('\n')
  })
})
