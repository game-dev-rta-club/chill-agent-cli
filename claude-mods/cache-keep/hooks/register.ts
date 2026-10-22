// Cache Keep: an idle conversation's prompt cache lives one hour. Each ping
// re-reads the conversation from the cache before it lapses, so the person's
// next message does not pay to write it all again. After the last ping the
// conversation is compacted if that makes it much smaller, then left alone.
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

// Size of a conversation right after compaction when none was seen yet:
// the system prompt and tools (about 50k) plus a summary (about 30k).
const DEFAULT_COMPACTED_TOKENS = 80_000
// A drop below this share of the previous size is read as a compaction.
const COMPACTION_DROP = 0.7

type Settings = { enabled: boolean; pingMs: number; pings: number; compactBelow: number }

let settings: Settings = { enabled: true, pingMs: 55 * 60_000, pings: 5, compactBelow: 0.6 }
let timer: { cancel: () => void } | undefined
let pingsSent = 0
let compacting = false
let lastTokens: number | undefined
let compactedTokens: number | undefined

export function readSettings(options: PluginOptions): Settings {
  const number = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
  return {
    enabled: options.enabled !== false,
    pingMs: number(options.pingMinutes, 55, 1, 59) * 60_000,
    pings: Math.round(number(options.pings, 5, 0, 24)),
    compactBelow: number(options.compactBelowPercent, 60, 1, 100) / 100,
  }
}

// Compact only when the result would be clearly smaller than now.
export function shouldCompact(current: number | undefined, compacted: number | undefined, below: number): boolean {
  if (!current) return false
  return (compacted ?? DEFAULT_COMPACTED_TOKENS) / current < below
}

function stop() {
  timer?.cancel()
  timer = undefined
}

async function contextTokens($: EngineInterface): Promise<number | undefined> {
  return (await $.session.usage()).context.tokens
}

async function ping($: EngineInterface): Promise<boolean> {
  const reply = await $.model.fork({ prompt: 'Cache Keep ping: reply with the single word ok.' })
  if (reply.isAnswered) return true
  $.ui.log(`Cache Keep: ping not answered (${reply.reason}); pings stop until the next turn`)
  return false
}

async function compact($: EngineInterface) {
  compacting = true
  try {
    await $.command.run({ command: 'compact' })
  } finally {
    compacting = false
  }
}

async function onIdle($: EngineInterface) {
  timer = undefined
  if (!settings.enabled) return
  if (pingsSent < settings.pings) {
    pingsSent++
    if (await ping($)) timer = $.clock.after(settings.pingMs, () => void onIdle($))
    return
  }
  const current = await contextTokens($)
  if (shouldCompact(current, compactedTokens, settings.compactBelow)) await compact($)
  else await ping($)
}

async function afterTurn($: EngineInterface) {
  const tokens = await contextTokens($)
  if (tokens && lastTokens && tokens < lastTokens * COMPACTION_DROP) compactedTokens = tokens
  lastTokens = tokens
  pingsSent = 0
  stop()
  if (settings.enabled) timer = $.clock.after(settings.pingMs, () => void onIdle($))
}

const mainThread = (e: object) => !('agentId' in e && e.agentId)

export const register: Register = (on, options) => {
  settings = readSettings(options)
  on('turn.start', async ($, e, next) => {
    if (mainThread(e) && !compacting) stop()
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (mainThread(e) && !compacting) await afterTurn($)
    return result
  })
  on('session.end', async ($, e, next) => {
    stop()
    return next(e)
  })
}
