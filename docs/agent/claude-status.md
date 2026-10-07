---
keyPoints: >-
  The Claude Agent menu and connection show distinguish recorded main hooks,
  finite reply checks, stale or expired watchers and session exit. Reads never
  restart a watcher or resend feedback; recovery stays in the original conversation.
---

# Know whether Claude's reply watcher checked recently

Open the Agent menu on a Claude-owned Goal to see the last recorded connection
evidence. `connection show` exposes the same status from the conversation's
exported shell environment. Child Goals use their Root's original connection.
This experimental display helps explain a missing reply without guessing whether
Claude is currently running or idle.

A finite watcher records a check at startup and at most every five seconds while
polling. The menu shows its last check and deadline. If checks stop for fifteen
seconds, the display becomes **Reply watch unconfirmed**, even if the deadline is
still in the future. An expired deadline becomes **Reply watch expired** on read,
including when a terminated worker never saved its final status. Opening the menu
does not renew the deadline, spawn work or change a delivery record.

**Reply offered** means the hook reserved feedback for native delivery; it does
not prove the Agent read it. The normal [receipt protocol](claude-actions.md)
still decides that. A SessionEnd hook records **Session ended**. A changed context
cannot lend its observations to Goals from the previous context. Missing or
unreadable records stay unknown.

The native stream-mode probe can exit successfully on EOF without a SessionEnd
callback. A missing callback is not proof that the conversation remains open:
stale checks and elapsed deadlines still change the display. The probe records
this observation separately from reply delivery and context retention.

## Recover in the original conversation

If a watch is expired or unconfirmed, open the original Claude conversation and
ask chill-agent to check its inbox. If it was closed, resume that same conversation
first. The [main-hook inbox](claude-actions.md) recovers saved replies and retains
the IDs of uncertain offers. A later verified response can establish a new finite
watch when that hook is installed. Do not create a replacement conversation to
recover an existing Goal.

The menu exposes labels and timestamps, not session tokens, working directories,
prompts or transcripts. Model settings, usage and execution controls stay
unavailable. This display qualifies the [finite watch](claude-idle.md); it does
not make it an overnight listener or prove that the native session is still open.
