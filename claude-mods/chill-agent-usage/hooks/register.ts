// Records the plan's rate-limit windows, as the last response reported them,
// for the Agent menu in chill's Web. One file for the account in the Claude
// folder beside the skills one; the latest reading wins. A session off a
// subscription reports none and leaves the file alone.
import type { Register } from 'claude-code'

export const register: Register = (on) => {
  // After each turn and when a window moves a point.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (!e.rateLimits.length) return result
    try {
      const at = new Date(await $.clock.now()).toISOString()
      await $.fs.write(`${$.plugin.root}/../../chill-agent-usage/usage.json`, JSON.stringify({ at, rateLimits: e.rateLimits }))
    } catch (error) {
      $.ui.log(`chill-agent usage not recorded (${error instanceof Error ? error.message : error})`)
    }
    return result
  })
}
