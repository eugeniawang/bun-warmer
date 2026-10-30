import { describe, expect, mock, test, tier } from 'claude-code/testing'
import { resolveCacheTtl } from '../hooks/register'
import type { On, PromptOrigin, TurnCompleteInput } from 'claude-code'

tier('user')

const MIN = 60 * 1000
const START = 1_800_000_000_000

type Auth = { handle: string; kind: 'bearer' | 'api-key' } | null | 'throw'

/** A session whose login kind, env, settings and rate limits each test chooses. Counts pings (forks). */
type Limits = Array<{ kind: string; percentUsed: number }> | 'throw'

function world(on: On, opts: { auth?: Auth; env?: Record<string, string>; settings?: Record<string, unknown>; rateLimits?: Limits; cacheGone?: boolean } = {}) {
  let limits: Limits = opts.rateLimits ?? [{ kind: 'five_hour', percentUsed: 10 }]
  const env = { BUN_WARMER_QUIET_HOURS: 'off', ...(opts.env ?? {}) }
  const files = new Map<string, string>()
  const forks: number[] = []
  const logs: string[] = []
  const auth = opts.auth === undefined ? { handle: 'h', kind: 'bearer' as const } : opts.auth
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/t' : env[e.name as keyof typeof env] }))
  on('fs.write', ($, e) => { files.set(e.path.replace(/\/\.([^/]+)\.tmp$/, '/$1'), e.text); return { value: undefined } })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'S1' }))
  on('session.authorize', () => { if (auth === 'throw') throw new Error('no'); return { value: auth } })
  on('settings.read', () => ({ value: (opts.settings ?? {}) as never }))
  on('session.usage', () => { if (limits === 'throw') throw new Error('no usage'); return { value: { startedAt: START, context: { window: 1000000, tokens: 200000 }, rateLimits: limits } as never } })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('agent.list', () => ({ value: [] as never }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('model.fork', async () => {
    forks.push(forks.length)
    const usage = opts.cacheGone
      ? { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }
      : { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 200000, cache_creation_input_tokens: 10 }
    return { value: { isAnswered: true, text: 'warm', usage } as never }
  })
  return { forks, logs, setLimits: (l: Limits) => { limits = l }, state: () => JSON.parse(files.get('/home/t/.claude/bun-warmer/S1.json.json') ?? files.get('/home/t/.claude/bun-warmer/S1.json') ?? 'null') as Record<string, any> }
}

const start = { surface: null, isInteractive: false, cwd: '/work' } as const
const answer = () => ({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' }) as TurnCompleteInput
const composer: PromptOrigin = { kind: 'composer' }

describe('resolveCacheTtl follows Anthropic precedence', () => {
  const base = { force5m: undefined, envTtl: undefined, settingTtl: undefined, enable1h: undefined, disabled: undefined, auth: 'bearer' as const }
  test('subscription login with nothing set: 1h, from the subscription default', () => {
    expect(resolveCacheTtl(base)).toEqual({ ttl: '1h', why: 'Claude subscription default' })
  })
  test('API key login with nothing set: 5m', () => {
    expect(resolveCacheTtl({ ...base, auth: 'api-key' }).ttl).toBe('5m')
  })
  test('no first-party login (cloud provider, gateway) or unreadable login: unknown', () => {
    expect(resolveCacheTtl({ ...base, auth: 'none' }).ttl).toBe('unknown')
    expect(resolveCacheTtl({ ...base, auth: 'unknown' }).ttl).toBe('unknown')
  })
  test('FORCE_PROMPT_CACHING_5M=1 beats everything', () => {
    expect(resolveCacheTtl({ ...base, force5m: '1', envTtl: '1h', settingTtl: '1h', enable1h: '1' }).ttl).toBe('5m')
  })
  test('CLAUDE_CODE_PROMPT_CACHE_TTL beats the setting; the setting beats ENABLE_PROMPT_CACHING_1H and the login default', () => {
    expect(resolveCacheTtl({ ...base, envTtl: '5m', settingTtl: '1h' }).ttl).toBe('5m')
    expect(resolveCacheTtl({ ...base, auth: 'api-key', envTtl: '1h' }).ttl).toBe('1h')
    expect(resolveCacheTtl({ ...base, auth: 'api-key', settingTtl: '1h' }).ttl).toBe('1h')
    expect(resolveCacheTtl({ ...base, settingTtl: '5m', enable1h: '1' }).ttl).toBe('5m')
    expect(resolveCacheTtl({ ...base, auth: 'none', enable1h: '1' }).ttl).toBe('1h')
  })
  test('values other than 5m or 1h are ignored, as Claude Code ignores them', () => {
    expect(resolveCacheTtl({ ...base, auth: 'api-key', envTtl: '60m', settingTtl: 'one hour' }).ttl).toBe('5m')
  })
  test('a model-specific disable (DISABLE_PROMPT_CACHING_HAIKU, _SONNET, _OPUS, _FABLE) counts as off: Bun Warmer cannot tell which model it covers', () => {
    expect(resolveCacheTtl({ ...base, disabledModel: 'DISABLE_PROMPT_CACHING_HAIKU' }).ttl).toBe('off')
  })
  test('DISABLE_PROMPT_CACHING=1: no cache at all', () => {
    expect(resolveCacheTtl({ ...base, disabled: '1' }).ttl).toBe('off')
  })
})

describe('no ping unless the main cache is known to last an hour', () => {
  const quietHour = async (on: On, $: any, opts: Parameters<typeof world>[1]) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, opts)
    await $.session.start(start)
    await $.turn.complete(answer())
    await clock.advance(70 * MIN)
    return { w, clock }
  }

  test('subscription login: pings as before', async ($, on) => {
    const { w } = await quietHour(on, $, {})
    expect(w.forks.length).toBe(1)
    expect(w.state().cacheTtl).toBe('1h')
  })

  test('API key login: never pings, and the state file says why', async ($, on) => {
    const { w } = await quietHour(on, $, { auth: { handle: 'h', kind: 'api-key' } })
    expect(w.forks.length).toBe(0)
    expect(w.state().cacheTtl).toBe('5m')
    expect(w.state().statusState).toBe('off')
    expect(w.state().statusText).toContain('not pinging')
    expect(w.state().statusText).toContain('5 minutes')
  })

  test('cloud provider or gateway (no first-party login): never pings', async ($, on) => {
    const { w } = await quietHour(on, $, { auth: null })
    expect(w.forks.length).toBe(0)
    expect(w.state().cacheTtl).toBe('unknown')
    expect(w.state().statusText).toContain('not pinging')
  })

  test('login kind unreadable: never pings', async ($, on) => {
    const { w } = await quietHour(on, $, { auth: 'throw' })
    expect(w.forks.length).toBe(0)
  })

  test('API key with CLAUDE_CODE_PROMPT_CACHE_TTL=1h: pings', async ($, on) => {
    const { w } = await quietHour(on, $, { auth: { handle: 'h', kind: 'api-key' }, env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' } })
    expect(w.forks.length).toBe(1)
  })

  test('API key with promptCacheTtl "1h" in settings: pings', async ($, on) => {
    const { w } = await quietHour(on, $, { auth: { handle: 'h', kind: 'api-key' }, settings: { promptCacheTtl: '1h' } })
    expect(w.forks.length).toBe(1)
  })

  for (const name of ['DISABLE_PROMPT_CACHING_HAIKU', 'DISABLE_PROMPT_CACHING_SONNET', 'DISABLE_PROMPT_CACHING_OPUS', 'DISABLE_PROMPT_CACHING_FABLE']) {
    test(`subscription with ${name}=1: never pings`, async ($, on) => {
      const { w } = await quietHour(on, $, { env: { [name]: '1' } })
      expect(w.forks.length).toBe(0)
      expect(w.state().cacheTtl).toBe('off')
    })
  }

  test('subscription with FORCE_PROMPT_CACHING_5M=1: never pings', async ($, on) => {
    const { w } = await quietHour(on, $, { env: { FORCE_PROMPT_CACHING_5M: '1' } })
    expect(w.forks.length).toBe(0)
  })

  test('subscription past its plan limit (a rate-limit window at 100%): on usage credits, so no ping', async ($, on) => {
    const { w } = await quietHour(on, $, { rateLimits: [{ kind: 'five_hour', percentUsed: 100 }] })
    expect(w.forks.length).toBe(0)
    expect(w.state().statusText).toContain('usage credits')
  })

  test('subscription with no rate-limit reading yet: no proof it is within plan usage, so no ping', async ($, on) => {
    const { w } = await quietHour(on, $, { rateLimits: [] })
    expect(w.forks.length).toBe(0)
    expect(w.state().statusText).toContain('not pinging')
  })

  test('subscription whose usage cannot be read: no ping', async ($, on) => {
    const { w } = await quietHour(on, $, { rateLimits: 'throw' })
    expect(w.forks.length).toBe(0)
  })

  test('subscription on usage credits, then the window resets: pings resume', async ($, on) => {
    const { w, clock } = await quietHour(on, $, { rateLimits: [{ kind: 'five_hour', percentUsed: 100 }] })
    expect(w.forks.length).toBe(0)
    w.setLimits([{ kind: 'five_hour', percentUsed: 5 }, { kind: 'seven_day', percentUsed: 40 }])
    await $.prompt.submit({ text: 'hello', wait: false, origin: composer })
    await $.turn.complete(answer())
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('an explicit CLAUDE_CODE_PROMPT_CACHE_TTL=1h holds on usage credits too: pings', async ($, on) => {
    const { w } = await quietHour(on, $, { env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, rateLimits: [{ kind: 'five_hour', percentUsed: 100 }] })
    expect(w.forks.length).toBe(1)
  })

  test('subscription default, but a ping finds the cache gone: no more pings this session, even after new activity', async ($, on) => {
    const { w, clock } = await quietHour(on, $, { cacheGone: true })
    expect(w.forks.length).toBe(1)
    await $.prompt.submit({ text: 'hello', wait: false, origin: composer })
    await $.turn.complete(answer())
    await clock.advance(70 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.state().cacheTtl).toBe('5m')
  })

  test('a 5-minute cache never triggers the cold-send warning', async ($, on) => {
    const { w } = await quietHour(on, $, { auth: { handle: 'h', kind: 'api-key' } })
    await $.prompt.submit({ text: 'hello', wait: false, origin: composer })
    expect(w.logs.some(l => l.includes('went cold'))).toBe(false)
  })
})
