---
keyPoints: >-
  Cache Keep is a Claude Code mod in claude-mods/chill-agent-cache-keep. Claude
  setup and every update copy it into the user's Claude skills folder, turn it
  off for the user and on in chill's projects, so only chill conversations load
  it. It pings an idle conversation 55 minutes after its last request with
  $.model.fork so the one-hour prompt cache stays warm, tries a failed ping
  again each minute three times, and sends nothing once 59 minutes have
  passed. After 5 pings it runs /compact when compaction would leave under 60%
  of the conversation, judged by the first response after the last
  compaction or by everything but the messages. Each ping and compaction is logged per session.
  Settings are in the Claude Code config menu under Cache Keep; it is on by
  default.
---

# Keep an idle conversation's prompt cache

Claude Code keeps a conversation in a one-hour prompt cache. A person who comes
back after more than an hour pays to write the whole conversation into the cache
again; for a long conversation that is the most expensive call of the day.

Cache Keep runs inside the Claude Code process that owns the conversation:

```text
the turn's last request to the model
  ↓ 55 minutes
ping: $.model.fork reads the conversation from the cache and answers "ok"
  ↓ 55 minutes after each answered ping, 5 pings in all (5 hours 30 minutes)
compact (/compact through $.command.run) when it would leave under 60% of the
conversation; otherwise one last ping
  ↓
nothing more until the next turn
```

- A ping is a fork, not a turn: the transcript, hooks and chill's Stop
  continuation do not see it. It is one request, one cache read of the
  conversation.
- The 55 minutes count from when the turn last sent the conversation to the
  model (`turn.step`), not from when the turn ended, so a long last answer
  does not eat into the hour.
- A ping that is not answered is tried again a minute later, up to three times.
- Nothing is sent once 59 minutes have passed since the last request, a
  timer that fired late after the Mac slept included: the cache has lapsed by
  then, and a ping or compaction would pay to write it all again.
- A new turn cancels the pending ping and starts the count again.
- `$.session.compact()` is not available in headless sessions such as Claude
  Desktop's (Claude Code 2.1.304), so Cache Keep runs the `/compact` command.

## When it compacts

Compaction replaces the conversation's messages with a summary. Cache Keep
compacts when what would be left is under 60% of the conversation's current
size (the last response's input tokens):

- After a compaction in this process, by the person, the engine or Cache Keep
  (`session.compact`), what is left is the size of the first response after
  it. The compaction's own `tokensAfter` counts only the kept messages, not
  the system prompt and tools.
- Before one, what is left is the window's breakdown (as `/context` shows it)
  without its `Messages` row: the system prompt, tools, memory files and the
  rest, measured then. The summary is not counted. Without a `Messages` row it
  does not compact.

Checked in Claude Desktop with Claude Code 2.1.304: a 58k-token test
conversation's breakdown put what compaction would leave at 54k; the first
response after compacting it read 57k.

## What keeps the timer running

The timers live in the Claude Code process. When memory runs short, Claude
Desktop stops conversations idle for a minute or more, but not one with a
background task running. In Desktop, chill runs its reply waiter as a background
task ([waiting for Web replies](claude-wait.md)), so a chill conversation that
waits for Web input keeps its process and Cache Keep's timer. A conversation
that is stopped loses the timer; its next turn starts it again.

## Log

Each ping, retry, stop and compaction adds a line to
`<Claude folder>/chill-agent-cache-keep/<session id>.log` (the Claude folder is
`~/.claude` or `$CLAUDE_CONFIG_DIR`), for example:

```text
2026-10-23T02:55:04.120Z ping 1: 104233 tokens read from the cache, 3 written
2026-10-23T08:25:09.871Z compacting: 182004 tokens now, about 52113 after
2026-10-23T08:25:41.002Z compacted (manual) at 182004 tokens
2026-10-23T09:12:30.415Z size after the last compaction: 61208 tokens
```

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
