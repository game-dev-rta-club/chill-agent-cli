---
keyPoints: >-
  The Claude Agent menu and connection show report whether a reply waiter is
  recorded as running, the last main-hook evidence and session exit. Reads never
  start a waiter or resend feedback; recovery stays in the original conversation.
---

# Know whether Claude is waiting for Web replies

Open the Agent menu on a Claude-owned Goal to see the last recorded connection
evidence. `connection show` exposes the same status from the conversation's
exported shell environment. Child Goals use their Root's original connection.
The connection status explains a missing reply; whether Claude is responding
right now comes from its transcript (below).

| Status | Meaning |
| --- | --- |
| Waiting for Web replies | A [reply waiter](claude-wait.md) refreshed its record in the last 90 seconds |
| Conversation checked in / Response finished | Main hooks were observed, but no waiter is running |
| Session ended | A SessionEnd hook was recorded |
| Conversation context changed | The Goal belongs to an earlier context; a new context does not inherit it |
| Connection not observed | The record is missing or unreadable |

A saved reply in the Conversation also says when no waiter will wake Claude.
Opening the menu does not start a waiter or change a delivery record. A missing
SessionEnd is not proof that the conversation is still open.

## Recover in the original conversation

When no waiter is running, open the original Claude conversation and ask
chill-agent to check its inbox. If it was closed, resume that same conversation
first. The [main-hook inbox](claude-actions.md) recovers saved replies and its
result names the waiter to start again. Do not create a replacement conversation
to recover an existing Goal.

The menu exposes labels and timestamps, not session tokens, working directories,
prompts or transcripts. It also shows the model and effort the conversation last
answered with, read from the transcript path its hooks report. Changing the model,
usage and execution controls stay unavailable: Claude Code offers no route to change
a running conversation's model from outside it.

## Follow the response that received feedback

Under a delivered message, Activity shows the public text the agent wrote in the
response that received it, from the hook offer until that response stops or the
user starts another prompt, as a Codex turn does. Thinking, tool input and output,
and subagent text are never shown. The transcript is read incrementally and only
for conversations whose hooks reported it.

## See whether Claude is responding now

Claude and Codex Roots show the same running state. The Agent button, the
browser tab icon, the Goal list and the Agent menu's Activity show Running while
the conversation's transcript has an open response: a user or assistant entry
after the last Stop summary or interrupt. Subagent entries do not count. A
transcript with no write for 10 minutes counts as Idle, so a closed app does not
stay Running. Without a reported transcript the state is unknown.

The running Goal is the one whose feedback that response received. Activity
links to that feedback, and feedback received within one response shares one
Think, which opens while the response runs and closes when it stops. A response
that received no Web feedback shows Running without a Goal.
