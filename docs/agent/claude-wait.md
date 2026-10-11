---
keyPoints: >-
  The agent keeps `connection wait` running as a Claude background task. It exits
  when Web feedback is saved, which wakes an idle conversation; the agent claims it
  through the inbox and starts the waiter again. chill outputs name the waiter only
  when none is running. A live task also keeps Claude Desktop from evicting the session.
---

# Receive Web replies while Claude is idle

A Claude conversation hears about Web replies through a small background task:

```text
agent starts `chill connection wait` as a background task
        ↓ (waits; nothing is sent to the model)
user saves feedback on the Web
        ↓
waiter exits and prints the next actions
        ↓
Claude Code reports the finished task; an idle conversation starts a new turn
        ↓
agent claims it with `connection inbox`, replies, and starts the waiter again
```

The waiter only detects saved feedback for its own conversation context. It
never offers or marks feedback itself: the [main-hook inbox](claude-actions.md)
claims it, so holds, ownership checks and uncertain offers behave as in any
other delivery. Feedback saved while the waiter was not running stays saved and
wakes the next waiter immediately.

## How the agent learns to start it

No skill text is required. chill tells the agent at the moment it is relevant:

| When | Where the instruction appears |
| --- | --- |
| A Root is created, or an inbox / receipt action is confirmed, and no waiter runs | That action's hook result |
| The waiter has just exited with feedback | The waiter's own output |
| A resumed or compacted conversation owns Goals and no waiter runs | The SessionStart hook context |

Conversations that own no Goals never see these instructions. The wording lives
in one place in the Claude adapter (`waiterAction` in
[claude-actions](../../lib/claude-actions.mjs)); other connections deliver
natively and print nothing.

## One waiter per conversation

A waiter records itself in the conversation's connection record and refreshes
that record every 30 seconds. A second waiter for the same context exits at once.
A record that has not been refreshed for 90 seconds is treated as stopped, so a
killed waiter cannot hide the instruction for long and a reused process ID never
counts as running. Compact keeps a running waiter; clear and fork start a new
context, and an old waiter exits when its context changes.

## Why a background task

Claude Code wakes an idle conversation when one of its background tasks
finishes, and the task has no time limit. Claude Desktop also stops idle
sessions under memory pressure but keeps sessions that have a live background
task. The waiter therefore needs no expiry, renewal or extra user setting.

It cannot outlive the Claude process. Quitting Claude or the computer sleeping
stops it; saved replies wait for the conversation to be resumed, when the
SessionStart instruction applies. The [connection status](claude-status.md)
shows whether a waiter is currently recorded.

Implementation: [waiter](../../lib/claude-wait.mjs), [entry record](../../lib/claude-entry.mjs).
