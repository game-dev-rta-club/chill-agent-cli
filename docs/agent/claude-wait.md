---
keyPoints: >-
  The watcher hook (connection claude-watch, asyncRewake on SessionStart and
  Stop) waits in the background while a Claude conversation owns Goals. When Web
  feedback is saved it claims it and exits 2, so Claude Code wakes the model with
  the feedback; a due connection wake check wakes it the same way. The agent
  never starts, reads or restarts it, except in Claude Desktop: Desktop pauses
  idle conversations under memory pressure but not one running a background
  task, so there the agent runs connection wait as a task and the hook stands
  by. connection wait also remains for older setups.
---

# Receive Web replies while Claude is idle

chill installs a second command on the SessionStart and Stop hooks:

```text
response ends (Stop) or a session starts (SessionStart)
        ↓ Claude Code runs `chill connection claude-watch` in the background
          (asyncRewake); nothing is sent to the model while it waits
user saves feedback on the Web
        ↓
watcher claims it, as a tool hook would, and exits 2 with the feedback text
        ↓
Claude Code wakes the model with that text
        ↓
agent works and answers with `connection reply`; the response's Stop starts
the next watcher
```

The agent is not told about the watcher and never handles it. It sees Web
feedback the same way whether it was working (a tool hook offers it) or idle
(the watcher wakes it). Claude Code shows the user `chill-agent: Web input` in
the terminal when the watcher wakes the conversation.

## What the watcher does

- It watches only while the conversation owns a Root Goal. A conversation that
  owns none ends its watcher at once; its next Stop starts one again, for
  example after it creates a Goal.
- Feedback is claimed through the same inbox as tool hooks, so holds, a Web
  pause, ownership checks and Resume behave as in any other delivery.
- A `connection wake` check that is due wakes the conversation with its reason
  and is cleared, so it wakes once.
- It ends itself before the hook timeout (7 days) with a short routine check;
  the response that wakes starts the next watcher.

## One watcher per conversation

A watcher records itself in the conversation's connection record and refreshes
that record every 30 seconds. One that is stopped (SIGTERM, SIGINT or SIGHUP)
releases the record at once. Every Stop starts a watcher; while one is alive,
the new one checks that the recorded watcher still refreshes (up to 65 seconds)
and exits. A watcher killed without releasing its record is taken over. Status
treats a record that has not been refreshed for 90 seconds as stopped.

The watcher follows its session: compact keeps it, and after clear or fork it
watches the new context, ending if that context owns no Goal.

## Claude Desktop

Claude Desktop pauses an idle conversation when the Mac runs low on memory,
which ends the watcher hook with it; Web input then waits until the
conversation is opened again. Desktop never pauses a conversation with a
background task running (Bash run_in_background, Monitor, subagents), and it
does not count hooks as such tasks.

So when `CLAUDE_CODE_ENTRYPOINT` is `claude-desktop`, the waiter runs as a
task: chill asks the agent to start `connection wait` in the background
(SessionStart after a resume, the next action of `connection` commands, and
once per Stop), and stops asking while one runs. The task takes over from the
watcher hook, which then ends quietly or stands by; outside Desktop the hook
takes over from a task, as below. The task exits when feedback is saved or a
check is due; that wakes the conversation, and the agent claims feedback with
`connection inbox` and starts the task again.

The cost is memory: a conversation with a running task is never paused, so
while many conversations wait for Web replies, Desktop has fewer to pause.

## Setups without the watcher hook

Hooks installed by an earlier setup have no watcher until setup prepare or a
runtime update refreshes them. There, `connection wait` is the older route: the
agent starts it as a background task, it exits when feedback is saved or a check
is due, and the agent claims feedback with `connection inbox` and starts it
again. chill names it only while the project's hooks lack the watcher. A watcher
hook takes over from a running `connection wait` task.

Implementation: [watcher](../../lib/claude-wait.mjs), [hooks](../../lib/claude-setup.mjs), [scheduled checks](../../lib/claude-wake.mjs), [entry record](../../lib/claude-entry.mjs).
