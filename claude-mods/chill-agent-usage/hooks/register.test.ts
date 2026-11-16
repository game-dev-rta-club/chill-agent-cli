import { expect, mock, test } from 'claude-code/testing'

test('records the plan usage the last response reported', async ($, on) => {
  mock.clock(on)
  const writes: { path: string; text: string }[] = []
  on('fs.write', (_: any, e: any) => {
    writes.push(e)
    return { value: undefined }
  })
  on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
  const context = { window: 1_000_000, tokens: 400_000 }
  await $.session.measure({ context, rateLimits: [], changed: ['context'] })
  expect(writes.length).toBe(0)
  const rateLimits = [
    { kind: 'five_hour', percentUsed: 26, resetsAt: '2026-10-26T08:00:00.000Z' },
    { kind: 'seven_day', percentUsed: 3, resetsAt: '2026-11-02T05:00:00.000Z' },
  ]
  await $.session.measure({ context, rateLimits, changed: ['rateLimits'] })
  expect(writes.length).toBe(1)
  expect(writes[0].path.endsWith('/chill-agent-usage/usage.json')).toBe(true)
  expect(JSON.parse(writes[0].text).rateLimits).toEqual(rateLimits)
})
