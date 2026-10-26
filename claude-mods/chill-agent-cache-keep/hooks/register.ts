// Cache Keep: an idle conversation's prompt cache lives one hour. Each ping
// re-reads the conversation from the cache before it lapses, so the person's
// next message does not pay to write it all again. After the last ping the
// conversation is compacted if that makes it much smaller, then left alone.
import type { EngineInterface, PluginOptions, Register, SessionRateLimit } from 'claude-code'

// The cache lapses an hour after the request that last read it. Nothing is
// sent once this much has passed, so a late timer (a Mac waking from sleep)
// never pays to write the whole conversation again.
const CACHE_LIMIT_MS = 59 * 60_000
const RETRY_MS = 60_000
const RETRIES = 3

type Settings = { enabled: boolean; pingMs: number; pings: number; compactBelow: number }

let settings: Settings = { enabled: true, pingMs: 55 * 60_000, pings: 5, compactBelow: 0.6 }
let timer: { cancel: () => void } | undefined
let pingsSent = 0
let retriesLeft = RETRIES
let compacting = false
// When the main thread or a ping last sent the conversation to the model.
let lastSentAt: number | undefined
// The conversation's size right after its last compaction in this process,
// read off the first response that followed it.
let compactedTokens: number | undefined
let compactedSizeUnknown = false

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
  if (!current || compacted === undefined) return false
  return compacted / current < below
}

function stop() {
  timer?.cancel()
  timer = undefined
}

function wait($: EngineInterface, ms: number) {
  timer = $.clock.after(ms, () => void onIdle($))
}

// One line per ping and compaction, in the Claude folder beside the skills one.
async function note($: EngineInterface, text: string) {
  try {
    const path = `${$.plugin.root}/../../chill-agent-cache-keep/${await $.session.id()}.log`
    const earlier = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
    await $.fs.write(path, `${earlier}${new Date(await $.clock.now()).toISOString()} ${text}\n`)
  } catch (error) {
    $.ui.log(`Cache Keep: ${text} (not logged: ${error instanceof Error ? error.message : error})`)
  }
}

// The plan's rate-limit windows, as the last response reported them, for the
// Agent menu in chill's Web. One file for the account; the latest reading wins.
// A session off a subscription reports none and leaves the file alone.
async function recordUsage($: EngineInterface, rateLimits: readonly SessionRateLimit[]) {
  if (!rateLimits.length) return
  try {
    const at = new Date(await $.clock.now()).toISOString()
    await $.fs.write(`${$.plugin.root}/../../chill-agent-cache-keep/usage.json`, JSON.stringify({ at, rateLimits }))
  } catch (error) {
    $.ui.log(`Cache Keep: usage not recorded (${error instanceof Error ? error.message : error})`)
  }
}

// What compaction would leave: the last one's result, or before one, all of
// the window but the messages, which compaction replaces with a summary.
async function compactedEstimate($: EngineInterface): Promise<number | undefined> {
  if (compactedTokens !== undefined) return compactedTokens
  const rows = (await $.session.usage({ breakdown: 'summary' })).context.breakdown?.categories.filter((row) => row.kind === 'used')
  if (!rows?.some((row) => row.name === 'Messages')) return undefined
  return rows.filter((row) => row.name !== 'Messages').reduce((sum, row) => sum + row.tokens, 0)
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
  const now = await $.clock.now()
  if (lastSentAt !== undefined && now - lastSentAt >= CACHE_LIMIT_MS) {
    await note($, `stopped: ${Math.round((now - lastSentAt) / 60_000)} minutes since the last request, the cache has likely lapsed`)
    return
  }
  const last = pingsSent >= settings.pings
  if (last) {
    const current = (await $.session.usage()).context.tokens
    const compacted = await compactedEstimate($)
    if (shouldCompact(current, compacted, settings.compactBelow)) {
      await note($, `compacting: ${current} tokens now, about ${compacted} after`)
      await compact($)
      return
    }
  }
  const reply = await $.model.fork({ prompt: 'Cache Keep ping: reply with the single word ok.' })
  if (reply.isAnswered) {
    lastSentAt = now
    pingsSent++
    retriesLeft = RETRIES
    await note($, `ping ${pingsSent}: ${reply.usage.cache_read_input_tokens} tokens read from the cache, ${reply.usage.cache_creation_input_tokens} written`)
    if (!last) wait($, settings.pingMs)
  } else if (retriesLeft > 0) {
    retriesLeft--
    await note($, `ping not answered (${reply.reason}); trying again in a minute`)
    wait($, RETRY_MS)
  } else {
    await note($, `ping not answered (${reply.reason}); pings stop until the next turn`)
  }
}

async function afterTurn($: EngineInterface) {
  const now = await $.clock.now()
  if (compactedSizeUnknown) {
    compactedTokens = (await $.session.usage()).context.tokens
    compactedSizeUnknown = compactedTokens === undefined
    if (compactedTokens !== undefined) await note($, `size after the last compaction: ${compactedTokens} tokens`)
  }
  pingsSent = 0
  retriesLeft = RETRIES
  stop()
  if (!settings.enabled) return
  lastSentAt ??= now
  wait($, Math.max(0, lastSentAt + settings.pingMs - now))
}

const mainThread = (e: object) => !('agentId' in e && e.agentId)

export const register: Register = (on, options) => {
  settings = readSettings(options)
  on('turn.start', async ($, e, next) => {
    if (mainThread(e) && !compacting) {
      stop()
      lastSentAt = undefined
    }
    return next(e)
  })
  on('turn.step', async function* ($, e, next) {
    if (mainThread(e)) lastSentAt = await $.clock.now()
    return yield* next(e)
  })
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (mainThread(e) && !compacting) await afterTurn($)
    return result
  })
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (mainThread(e) && e.trigger !== 'precompute' && !result.skip) {
      // Its tokensAfter counts the kept messages alone, not the system prompt
      // and tools, so the size is read off the first response after it.
      compactedTokens = undefined
      compactedSizeUnknown = true
      await note($, `compacted (${e.trigger}) at ${result.tokensBefore ?? 'unknown'} tokens`)
    }
    return result
  })
  // After each turn and when a window moves a point; recorded even with Cache Keep off.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await recordUsage($, e.rateLimits)
    return result
  })
  on('session.end', async ($, e, next) => {
    stop()
    return next(e)
  })
}
