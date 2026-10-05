---
keyPoints: >-
  Feedback is saved before native queue delivery. Explicit receipts claim it;
  uncertain sends are reconciled instead of resent. Pause preserves unrelated queues.
---

# Connect the conversation to an agent

The current harness integration connects to Codex Desktop on macOS. Assign a
chat to a root Goal with `goal assign`; children inherit it. An unassigned root
can still store Goals and discussion but cannot deliver feedback to an agent.
Changing the assignment does not replay already queued feedback to the new chat.

## From saved feedback to work

```text
Web feedback → saved Conversation → native chat queue → agent receipt → result
```

The feedback is saved before delivery. Queueing lets the native harness choose
when to run it instead of starting a competing execution. If a send may have
succeeded but its receipt is missing, the CLI checks the queue and turn history.
It does not blindly send the same request again.

A project hook can expose pending feedback for the Goal selected in the current
turn. The native queue remains a fallback until the agent claims the feedback
with `goal activity --event <ID> --state working`. That receipt removes only
matching chill-agent queue entries. Feedback for other Goals remains queued.

Read all delivered messages, apply later corrections, and skip already completed
events. When the requested work is finished, record `completed`; use `failed` if
it could not be completed. An activity receipt does not select a work Goal or
mark a Goal Done. See [execution state](execution-state.md).

## Pause and resume

Web can pause feedback while it is saved, queued or running. It holds the affected
Goal's pending feedback and removes only its matching native queue entries; when
necessary it interrupts the associated turn. New feedback for a held Goal is
saved until resume. Resume combines held messages in order and delivers them to
the assigned chat.

Controls validate the current chat, turn and receipt before acting. If that
evidence has changed or is uncertain, the UI checks again instead of treating a
stale button as permission to control a different run. A Running visual alone
does not grant Stop or Resume capability.

Model and reasoning controls also depend on the connected harness's capabilities.
They validate supported choices and expected current settings before saving;
unavailable integration is not represented as a successful change.

Implementation: [delivery](../../lib/delivery.mjs),
[held feedback](../../lib/feedback-hold.mjs), [controls](../../lib/agent-status.mjs).
