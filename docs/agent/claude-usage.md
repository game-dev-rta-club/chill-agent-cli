---
keyPoints: >-
  A small Claude Code mod in claude-mods/chill-agent-usage records the plan's
  rate-limit windows that each response reports, for the Agent menu's Usage.
  Claude setup and every update copy it into the user's Claude skills folder,
  turn it off for the user and on in chill's projects. They also delete the
  Cache Keep mod chill shipped before; Cache Keep is now the standalone plugin.
---

# Record the plan's usage for the Agent menu

After each turn, and when a rate-limit window moves a point, the mod writes the
windows the last response reported (`$.session.usage().rateLimits`: kind,
percent used, reset time) with the time to
`<Claude folder>/chill-agent-usage/usage.json`. The Claude folder is
`~/.claude` or `$CLAUDE_CONFIG_DIR`. One file serves the account; the latest
reading wins. A session off a Pro or Max plan reports none and leaves the file
alone. The Agent menu reads it
([Claude status](claude-status.md#see-the-plans-usage)). This costs no request:
the values come with the responses the conversation already gets.

## Where it runs

Claude Code loads a mod from the user's skills folder (`~/.claude/skills`, or
`$CLAUDE_CONFIG_DIR/skills`) with no install step, as
`chill-agent-usage@skills-dir`. Claude setup (`chill-setup prepare
--harness claude-code`) and every runtime update, which refreshes the projects
set up before, do three things in this order:

1. Turn it off for the user: `enabledPlugins` in the user's `settings.json`
   gets `"chill-agent-usage@skills-dir": false`, unless the person already set
   a value. This comes first, so the mod is never loaded in other folders.
2. Copy the mod into the skills folder, replacing the old version.
3. Turn it on in the project: the same key, `true`, in the project's
   `.claude/settings.local.json`, next to chill's hooks, unless the person set
   it there. Claude Code applies the main checkout's local settings in its
   worktrees too.

Removing chill from a project takes back only that `true`. When the user
settings cannot be read, setup leaves the mod out and sets up the hooks.

## Cache Keep moved out

chill used to ship Cache Keep, which keeps an idle conversation's prompt cache,
as this mod. It is now the standalone plugin
[game-dev-rta-club/cache-keep](https://github.com/game-dev-rta-club/cache-keep),
which each person installs once for their user. Until 2026-12-01, setup and
updates delete the old mod (`<Claude folder>/skills/chill-agent-cache-keep`)
and its folder (`<Claude folder>/chill-agent-cache-keep`), so it does not ping
beside the standalone one. They also delete the
`chill-agent-cache-keep@skills-dir` values chill set: `false` in the user's
settings and `true` in the project's. A value the person set stays.

## Test

`claude plugin test claude-mods/chill-agent-usage` runs the mod's test against
Claude Code's own test kit.

Implementation: [hooks module](../../claude-mods/chill-agent-usage/hooks/register.ts), [test](../../claude-mods/chill-agent-usage/hooks/register.test.ts), [setup](../../lib/claude-setup.mjs).
