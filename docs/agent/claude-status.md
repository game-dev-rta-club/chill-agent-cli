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
The display explains a missing reply without guessing whether Claude is
currently running or idle.

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
prompts or transcripts. Model settings, usage and execution controls stay
unavailable.
