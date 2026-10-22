---
keyPoints: >-
  Cache Keep is a Claude Code plugin (a mod) in claude-mods/cache-keep. It pings
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
- The timers live in the Claude Code process. Claude Desktop stops an idle
  conversation's process unless a background task runs, so in Desktop Cache
  Keep works in conversations that keep one running, such as chill's reply
  waiter (see [Receive Web replies while Claude is idle](claude-wait.md)).

Checked in Claude Desktop with Claude Code 2.1.304: each ping read the
conversation from the cache (55k tokens read, 0 to 3 written), and `/compact`
through `$.command.run` compacted it from 55k to 10k tokens. A conversation with
no background task was stopped about a minute after its turn, before its second
ping.

## Settings

The Claude Code config menu lists them under Cache Keep: on or off (on by
default), minutes between pings (55), pings before compacting (5) and the
compaction threshold in percent (60).

## Install

```sh
claude plugin marketplace add game-dev-rta-club/chill-agent-cli
claude plugin install cache-keep@chill-agent --scope local
```

`--scope local` turns it on for the current project only.

## Test

`claude plugin test claude-mods/cache-keep` runs the plugin's tests against
Claude Code's own test kit, with a mocked clock.

Implementation: [hooks module](../../claude-mods/cache-keep/hooks/register.ts), [tests](../../claude-mods/cache-keep/hooks/register.test.ts).
