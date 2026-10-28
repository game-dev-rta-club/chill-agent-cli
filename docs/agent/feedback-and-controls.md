---
keyPoints: >-
  Feedback is saved first and handed to the Root's agent by one cursor per Root.
  A Comment on the Goal answers it; there are no receipts. While the agent's own
  work runs, feedback waits for its end unless the user sends it now. Pause holds
  everything until Resume; a stop in the agent's own app shows as Interrupted.
---

# Connect the conversation to an agent

A root Goal is assigned to one agent conversation (a Codex chat with `goal
assign`, a Claude Code conversation through its connection); children inherit
it. An unassigned root still stores Goals and discussion, and its feedback shows
Saved until an agent takes the Root over.

## From saved feedback to the agent

```text
Web feedback → saved Conversation → handed to the Root's agent → the agent's Comment on the Goal
```

Each Root keeps one cursor: the last comment handed to its agent
(`workspace/hand-off/<rootId>.json`). A comment after it has not been handed yet.
The cursor moves only after the comments are handed, so nothing is handed twice,
and it stays with the Root when another conversation takes it over: the new owner
receives only what the earlier one was never handed.

How the comments are carried depends on the harness. An idle Codex chat is sent
every waiting comment as one message; a Codex chat that cannot be reached keeps
them Saved and is sent them once chill can reach it. Claude Code receives them
through its hooks: a tool hook while it works, the watcher hook while it is idle. Either way, the same text lists the
comments as data, with the command to read each Goal and the command to reply on it, which answers it (`feedbackText` in
[delivery](../../lib/delivery.mjs)).

## Waiting: feedback saved while the agent works

Feedback saved while the agent's own work runs is marked Waiting. It is handed
when that work ends: Codex's and Claude's Stop hooks hand it and the work goes on.
Background work alone (a subagent, a background command) does not make feedback
wait. Feedback saved before the work started is not Waiting: it is what woke the
agent, and the work takes it at its next tool hook. **Send now** on the Web
(`goal send-now --event <ID>`) hands that comment, with the ones before it, to
the running work at its next tool hook; comments written after it keep waiting.
The comments before it go too, so the cursor keeps the order.

## Replying

A Goal waits for a reply while the user commented after the agent's last Comment
or Letter on it. The agent answers by commenting on the Goal; one Comment answers
all of the user's comments before it. No comment ID and no receipt is needed, and
a progress Comment answers the Goal as well. A reply that asks the user to
decide or approve something carries `--ask '<what to decide>'` and is saved as
a Letter; it answers the Goal the same way. The user's next comment on that Goal
closes its open Letters. A Comment from another agent conversation is refused.

## When the agent stops

The user reads only the Web. An agent that ends its work while a Goal it was
handed comments on still waits for a reply, with nothing of it running to wake it
later, makes the Web look stopped. chill holds that stop once and asks the agent
to tell the user where things stand: reply if it is handled, or post a progress
Comment that says what it waits for and when it will check. The stop right after a
hold always ends. Claude Code names its background work in the Stop input; Codex's
Stop input names none, so a Codex chat is held even while a background terminal
runs. The rule is `quietGoals` in [agent rules](../../lib/agent-rules.mjs).

## What the Web shows

- The Goal list and heading show Running on the Goals the agent works on now; a
  parent runs while a Split Goal runs. Whether a Goal awaits a reply is the
  agent's to track: the Web does not show it on the Goal, only under each comment.
- Under a comment that still waits for a reply, one small mark says where it is:
  Saved, Waiting, Paused, Sent or Interrupted. A reply on the Goal clears them.
- In the conversation, the agent's state on this Goal (Running, Queued,
  Paused, Interrupted, Ended) with its Pause or Resume and Think: the public text
  of its current or last work here. A live state stays after the conversation;
  an ended one stands where the work ended, before later comments. A running
  parent instead links to the Split Goal the work is in.

## Pause, Resume and Interrupted

Pause is the user's: it stops the agent's current work where the harness can
(Codex interrupts the turn), and hands no feedback until Resume. Resume hands
what waits in one message, or asks the agent to go on with the stopped work. A
new comment from the user resumes the agent the same way, so it is handed
without a separate Resume; if resuming fails, the comment stays saved and shows
Paused. A stop in the agent's own app (Esc, Desktop's stop, an
API error) is Interrupted, shown on the agent and on the comments it was handed;
feedback is handed to an interrupted agent at once, and its next work shows
Running again.

Controls check the current agent and turn before acting. If that has changed or
is uncertain, the page reads again instead of acting on a stale button.

Model and reasoning controls depend on the connected harness. See
[model settings](model-settings.md).

Implementation: [agent rules](../../lib/agent-rules.mjs),
[hand-off](../../lib/hand-off.mjs), [delivery](../../lib/delivery.mjs),
[controls](../../lib/agent-status.mjs).
