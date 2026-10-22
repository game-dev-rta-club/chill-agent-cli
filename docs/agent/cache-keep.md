---
keyPoints: >-
  Cache Keep is a Claude Code mod in claude-mods/chill-agent-cache-keep. Claude
  setup and every update copy it into the user's Claude skills folder, turn it
  off for the user and on in chill's projects, so only chill conversations load
  it. It pings
  an idle conversation every 55 minutes with $.model.fork so the one-hour prompt
  cache stays warm, and after 5 pings it runs /compact through $.command.run when
  that would make the conversation clearly smaller. Settings are in the Claude
  Code config menu under Cache Keep; it is on by default.
---

# Keep an idle conversation's prompt cache

Claude Code keeps a conversation in a one-hour prompt cache. A person who comes
back after more than an hour pays to write the whole conversation into the cache
again; for a long conversation that is the most expensive call of the day.

Cache Keep runs inside the Claude Code process that owns the conversation:

```text
a turn ends
  ↓ 55 minutes idle
ping: $.model.fork reads the conversation from the cache and answers "ok"
  ↓ repeated, 5 pings in all (5 hours 30 minutes)
compact (/compact through $.command.run) when the size right after the last
compaction is below 60% of the current size; otherwise one last ping
  ↓
nothing more until the next turn
```

- A ping is a fork, not a turn: the transcript, hooks and chill's Stop
  continuation do not see it. It costs one cache read of the conversation.
- A new turn cancels the pending ping and starts the count again.
- Without an earlier compaction in this process, the size after compaction is
  taken as 80k tokens (system prompt and tools, plus a summary).
- `$.session.compact()` is not available in headless sessions such as Claude
  Desktop's (Claude Code 2.1.304), so Cache Keep runs the `/compact` command.
- The timers live in the Claude Code process. When memory runs short, Claude
  Desktop stops conversations idle for a minute or more, oldest first, but not
  one with a running background task or a scheduled task (CronCreate). So
  while it waits, Cache Keep keeps one one-shot task (CronCreate) set past its
  last ping, renewed when a turn ends with it less than the whole wait away,
  and deletes it after the last step. The task's prompt only asks for "ok", in
  case it ever fires.

Checked in Claude Desktop with Claude Code 2.1.304: each ping read the
conversation from the cache (55k tokens read, 0 to 3 written), and `/compact`
through `$.command.run` compacted it from 55k to 10k tokens. A conversation with
no background task and no scheduled task was stopped under memory pressure
about two minutes after its turn, before its second ping.

## Settings

The Claude Code config menu lists them under Cache Keep: on or off (on by
default), minutes between pings (55), pings before compacting (5) and the
compaction threshold in percent (60).

## Where it runs

Claude Code loads a mod from the user's skills folder (`~/.claude/skills`, or
`$CLAUDE_CONFIG_DIR/skills`) with no install step, as
`chill-agent-cache-keep@skills-dir`. Claude setup (`chill-setup prepare
--harness claude-code`) and every runtime update, which refreshes the projects
set up before, do three things in this order:

1. Turn it off for the user: `enabledPlugins` in the user's `settings.json`
   gets `"chill-agent-cache-keep@skills-dir": false`, unless the person already
   set a value. This comes first, so the mod is never loaded in other folders.
2. Copy the mod into the skills folder, replacing the old version.
3. Turn it on in the project: the same key, `true`, in the project's
   `.claude/settings.local.json`, next to chill's hooks, unless the person set
   it there. Claude Code applies the main checkout's local settings in its
   worktrees too.

Removing chill from a project takes back only that `true`. When the user
settings cannot be read, setup leaves Cache Keep out and sets up the hooks.

## Test

`claude plugin test claude-mods/chill-agent-cache-keep` runs the plugin's tests against
Claude Code's own test kit, with a mocked clock.

Implementation: [hooks module](../../claude-mods/chill-agent-cache-keep/hooks/register.ts), [tests](../../claude-mods/chill-agent-cache-keep/hooks/register.test.ts).
