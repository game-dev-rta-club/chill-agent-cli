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
agent runs `connection inbox` and starts the waiter again in one response,
then answers with `connection reply`
```

The agent need not read the finished task's output: the inbox shows saved
feedback and any due check. While a checked-in response is still calling tools,
the waiter does not end for feedback; the next tool hook offers it instead.

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
that record every 30 seconds. A waiter that is stopped (SIGTERM, SIGINT or
SIGHUP, as a stopped background task receives) releases the record at once.

A second waiter for the same context first checks that the recorded one is
alive: it watches the refresh for up to 65 seconds and exits only if it advances.
If it does not, the recorded waiter was killed without releasing it, and the new
waiter takes over. So restarting the waiter right after stopping one never leaves
the conversation without a waiter. Status treats a record that has not been
refreshed for 90 seconds as stopped, and a reused process ID never counts as
running. Compact keeps a running waiter; clear and fork start a new
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

## Scheduled checks

Something outside chill, such as CI finishing, wakes nobody by itself, and Auto
mode rests after a check finds no work. Before ending a response that waits for
such a thing, the conversation runs `connection wake --in <minutes> --reason
<text>`. The check is kept in the conversation's record. The waiter ends when it
is due, which wakes the conversation with the reason, and clears it so it wakes
once. The next `connection inbox` names the due check once, too. One check is kept per conversation; `--cancel` removes it.

Implementation: [waiter](../../lib/claude-wait.mjs), [scheduled checks](../../lib/claude-wake.mjs), [entry record](../../lib/claude-entry.mjs).
