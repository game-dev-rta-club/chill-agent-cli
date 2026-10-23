import { expect, mock, test } from 'claude-code/testing'

const MINUTE = 60_000

// Stands for the engine beneath Cache Keep: counts pings and compactions,
// answers the context size and its breakdown the test sets, fails the pings
// it is told to, and keeps the log in memory.
function engine(on: any, size: { now: number; messages?: number }) {
  const seen = { pings: 0, compacts: 0, failPings: 0, log: '' }
  const breakdown = () => {
    const messages = size.messages ?? size.now - 50_000
    return {
      categories: [
        { name: 'System prompt', tokens: 20_000, kind: 'used' },
        { name: 'System tools', tokens: size.now - messages - 20_000, kind: 'used' },
        { name: 'Messages', tokens: messages, kind: 'used' },
        { name: 'Free space', tokens: 500_000, kind: 'free' },
      ],
    }
  }
  on('session.usage', (_: any, e: any) => ({
    value: { startedAt: 0, context: { window: 1_000_000, tokens: size.now, ...(e?.breakdown ? { breakdown: breakdown() } : {}) }, rateLimits: [] },
  }))
  on('session.id', () => ({ value: 's1' }))
  on('fs.exists', () => ({ value: seen.log !== '' }))
  on('fs.read', () => ({ value: seen.log }))
  on('fs.write', (_: any, e: any) => {
    seen.log = e.text
    return { value: undefined }
  })
  on('model.fork', () => {
    if (seen.failPings > 0) {
      seen.failPings--
      return { value: { isAnswered: false, reason: 'api-error', usage: {} } }
    }
    seen.pings++
    return { value: { isAnswered: true, text: 'ok', usage: { cache_read_input_tokens: size.now, cache_creation_input_tokens: 0 } } }
  })
  on('command.run', { command: 'compact' }, () => {
    seen.compacts++
    return { text: 'compacted' }
  })
  on('ui.log', () => ({ value: undefined }))
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'ok' }))
  return seen
}

const summary = { role: 'user', text: 'The conversation so far, in short.', toolUses: [] }

const turn = async ($: any) => {
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok' })
}

test('pings an idle conversation every 55 minutes, then compacts a large one', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { now: 400_000 })
  await turn($)
  await clock.advance(54 * MINUTE)
  expect(seen.pings).toBe(0)
  await clock.advance(1 * MINUTE)
  expect(seen.pings).toBe(1)
  await clock.advance(4 * 55 * MINUTE)
  expect(seen.pings).toBe(5)
  expect(seen.compacts).toBe(0)
  await clock.advance(55 * MINUTE)
  expect(seen.compacts).toBe(1)
  await clock.advance(10 * 55 * MINUTE)
  expect(seen.pings).toBe(5)
  expect(seen.log).toContain('ping 5: 400000 tokens read from the cache')
  expect(seen.log).toContain('compacting: 400000 tokens now, about 50000 after')
})

test('sends one last ping instead of compacting a conversation mostly outside its messages', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { now: 120_000, messages: 40_000 })
  await turn($)
  await clock.advance(6 * 55 * MINUTE)
  expect(seen.pings).toBe(6)
  expect(seen.compacts).toBe(0)
  await clock.advance(10 * 55 * MINUTE)
  expect(seen.pings).toBe(6)
})

test('judges by the size the last compaction left', async ($, on) => {
  const clock = mock.clock(on)
  const size = { now: 300_000 }
  const seen = engine(on, size)
  // tokensAfter counts the kept messages alone; the next response has the size.
  on('session.compact', () => ({ messages: [summary], tokensBefore: 500_000, tokensAfter: 20_000 }))
  await $.session.compact({ trigger: 'manual', messages: [summary] })
  await turn($)
  size.now = 400_000
  await clock.advance(6 * 55 * MINUTE)
  expect(seen.compacts).toBe(0)
  expect(seen.pings).toBe(6)
  expect(seen.log).toContain('compacted (manual) at 500000 tokens')
  expect(seen.log).toContain('size after the last compaction: 300000 tokens')
})

test('tries a failed ping again each minute, three times', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { now: 400_000 })
  await turn($)
  seen.failPings = 2
  await clock.advance(55 * MINUTE)
  expect(seen.pings).toBe(0)
  await clock.advance(2 * MINUTE)
  expect(seen.pings).toBe(1)
  // The next ping is 55 minutes after the one that was answered.
  await clock.advance(54 * MINUTE)
  expect(seen.pings).toBe(1)
  await clock.advance(1 * MINUTE)
  expect(seen.pings).toBe(2)
  seen.failPings = 4
  await clock.advance(55 * MINUTE + 3 * MINUTE)
  expect(seen.log).toContain('pings stop until the next turn')
  await clock.advance(10 * 55 * MINUTE)
  expect(seen.pings).toBe(2)
})

test('sends nothing once the cache has likely lapsed', { options: { pingMinutes: 58 } }, async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { now: 400_000 })
  await turn($)
  seen.failPings = 1
  await clock.advance(58 * MINUTE)
  expect(seen.pings).toBe(0)
  await clock.advance(1 * MINUTE)
  expect(seen.pings).toBe(0)
  expect(seen.log).toContain('stopped: 59 minutes since the last request')
  await clock.advance(10 * 55 * MINUTE)
  expect(seen.pings).toBe(0)
})

test('a new turn starts the count again', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { now: 400_000 })
  await turn($)
  await clock.advance(2 * 55 * MINUTE)
  expect(seen.pings).toBe(2)
  await $.turn.start({ text: 'back', turnId: 't2' })
  await clock.advance(5 * 55 * MINUTE)
  expect(seen.pings).toBe(2)
  await $.turn.complete({ turnId: 't2', reason: 'answer', answer: 'ok' })
  await clock.advance(5 * 55 * MINUTE)
  expect(seen.pings).toBe(7)
  expect(seen.compacts).toBe(0)
})

test('does nothing when Cache Keep is off', { options: { enabled: false } }, async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { now: 400_000 })
  await turn($)
  await clock.advance(10 * 55 * MINUTE)
  expect(seen.pings).toBe(0)
  expect(seen.compacts).toBe(0)
})

test('counts the 55 minutes from the last request of the turn', async ($, on) => {
  const clock = mock.clock(on)
  const seen = engine(on, { now: 400_000 })
  on('turn.step', async function* (_: any, e: any) {
    return { turnId: e.turnId, index: e.index, text: 'ok', answer: 'ok', toolUses: [] }
  })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'test', messageCount: 1 }));
  await clock.advance(10 * MINUTE)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok' })
  await clock.advance(44 * MINUTE)
  expect(seen.pings).toBe(0)
  await clock.advance(1 * MINUTE)
  expect(seen.pings).toBe(1)
})
