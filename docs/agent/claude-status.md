---
keyPoints: >-
  The Claude Agent menu and agent show report whether a watcher is
  recorded as running, the last hook and session exit. Reads never start a
  watcher or resend feedback; recovery stays in the original conversation.
---

# Know whether Claude is waiting for Web replies

Open the Agent menu on a Claude-owned Goal to see the last recorded connection
evidence. `agent show` exposes the same status from the conversation's
exported shell environment. Child Goals use their Root's original connection.
The connection status explains a missing reply; whether Claude is responding
right now comes from its transcript (below).

| Status | Meaning |
| --- | --- |
| Receives Web replies | A [watcher](claude-wait.md) refreshed its record in the last 90 seconds |
| Connected / Response finished | The conversation is recorded (the last hook was not Stop / was Stop), but no watcher is running |
| Session ended | A SessionEnd hook was recorded |
| Conversation context changed | The Goal belongs to an earlier context; a new context does not inherit it |
| Connection not observed | The record is missing or unreadable |

A saved reply in the Conversation also says when no watcher will wake Claude.
Opening the menu does not start a watcher or change a delivery record. A missing
SessionEnd is not proof that the conversation is still open.

## Recover in the original conversation

When no watcher is running, open the original Claude conversation; its
SessionStart starts the watcher again, and its next tool call receives saved
replies. If it was closed, resume that same conversation. The
[inbox](claude-actions.md) also recovers saved replies. Do not create a replacement conversation
to recover an existing Goal.

The menu exposes labels and timestamps, not session tokens, working directories,
prompts or transcripts. It also shows the model and effort the conversation last
answered with, read from the transcript path its hooks report. Changing the model
and execution controls stay unavailable: Claude Code offers no route to change
a running conversation's model from outside it.

## See the plan's usage

Usage shows the 5-hour and weekly windows as percent left with their reset
times, as Codex's does, and when they were read. [The usage mod](claude-usage.md)
records them from the last Claude Code response, so they update only while a
chill conversation runs; one file serves every project. A window past its reset
is dropped, and with none left, or off a Pro or Max plan, Usage is unavailable.

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
that received no Web feedback shows Running on the last Goal.
The last Goal is, for Claude, the Goal where the conversation last received
feedback or wrote a reply, Comment or Letter, kept across compaction and resume;
for Codex, the last selected Goal. Activity keeps a link to it after the work stops.

## Pause, Resume and Queue

The Agent menu shows the same Activity controls and Queue for Claude as for
Codex. Claude Desktop has no way to interrupt a running response from outside,
so Pause works through the conversation's own hooks
([claude-pause](../../lib/claude-pause.mjs)): its next tool call, in the main
conversation or a subagent, is refused with a reason to stop and end the
response; no end-of-turn check continues it and Autonomy answers no tool prompt.
A running command finishes first. The pause survives compact and resume. Resume
clears it and wakes the conversation once with a notice to continue, together
with any held feedback. A new Web comment resumes it the same way, so the
comment is handed rather than held.
A prompt the user types in the conversation itself also clears it, so a paused
conversation never needs the Web to be running to continue. Claude Code's own
wakes, schedules and task notices do not.

Queue lists feedback saved for the conversation that it has not received yet.
