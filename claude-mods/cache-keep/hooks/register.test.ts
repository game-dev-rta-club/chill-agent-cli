import { expect, mock, test } from 'claude-code/testing'

const MINUTE = 60_000

// Stands for the engine beneath Cache Keep: counts pings and compactions and
// answers the context size the test sets.
function engine(on: any, tokens: { now: number }) {
  const seen = { pings: 0, compacts: 0 }
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, tokens: tokens.now }, rateLimits: [] } }))
  on('model.fork', () => {
    seen.pings++
    return { value: { isAnswered: true, text: 'ok', usage: {} } }
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

const turn = async ($: any) => {
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok' })
}

test('pings an idle conversation every 55 minutes, then compacts a large one', async ($, on) => {
  const clock = mock.clock(on)
  const tokens = { now: 400_000 }
  const seen = engine(on, tokens)
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
})

test('sends one last ping instead of compacting a small conversation', async ($, on) => {
  const clock = mock.clock(on)
  const tokens = { now: 120_000 }
  const seen = engine(on, tokens)
  await turn($)
  await clock.advance(6 * 55 * MINUTE)
  expect(seen.pings).toBe(6)
  expect(seen.compacts).toBe(0)
  await clock.advance(10 * 55 * MINUTE)
  expect(seen.pings).toBe(6)
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
