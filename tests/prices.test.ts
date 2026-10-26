import { describe, expect, test, tier } from 'claude-code/testing'
import { pingUsd } from '../hooks/register'

tier('user')

const usage = (read: number, write = 0, input = 0, output = 0) => ({ cache_read_input_tokens: read, cache_creation_input_tokens: write, input_tokens: input, output_tokens: output })
const close = (a: number | null, b: number) => expect(Math.abs((a ?? NaN) - b) < 1e-9).toBe(true)

describe('pingUsd list prices', () => {
  test('Opus 5.5 reads at $0.20, writes at $8, outputs at $20 per MTok, not the Opus 5 row', () => {
    close(pingUsd('claude-opus-5-5', usage(1_000_000)), 0.2)
    close(pingUsd('claude-opus-5-5', usage(0, 1_000_000)), 8)
    close(pingUsd('claude-opus-5-5', usage(0, 0, 0, 1_000_000)), 20)
    close(pingUsd('claude-opus-5', usage(1_000_000)), 0.5)
  })

  test('Sonnet 5.5 reads at $0.10, Sonnet 5 at $0.20', () => {
    close(pingUsd('claude-sonnet-5-5', usage(1_000_000)), 0.1)
    close(pingUsd('claude-sonnet-5', usage(1_000_000)), 0.2)
  })

  test('Haiku 5.5 uses the long-prompt prices over 100,000 tokens, Haiku 4.5 keeps its own', () => {
    close(pingUsd('claude-haiku-5-5', usage(100_000)), 0.001)
    close(pingUsd('claude-haiku-5-5', usage(200_000)), 0.01)
    // Up to 100,000 prompt tokens: write $0.20, base input $0.10, output $0.50.
    close(pingUsd('claude-haiku-5-5', usage(0, 50_000, 50_000, 1_000_000)), 50_000 * 0.2 / 1e6 + 50_000 * 0.1 / 1e6 + 0.5)
    // 100,001 prompt tokens: the whole request moves to write $1, base input $0.50, output $2.50.
    close(pingUsd('claude-haiku-5-5', usage(1, 50_000, 50_000, 1_000_000)), 1 * 0.05 / 1e6 + 50_000 * 1 / 1e6 + 50_000 * 0.5 / 1e6 + 2.5)
    close(pingUsd('claude-haiku-4-5', usage(200_000)), 0.02)
  })

  test('an unknown model has no price', () => {
    expect(pingUsd('some-other-model', usage(1000))).toBe(null)
    expect(pingUsd(null, usage(1000))).toBe(null)
  })
})
