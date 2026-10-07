---
keyPoints: >-
  Feedback is saved before native queue delivery. Explicit receipts claim it;
  uncertain sends are reconciled instead of resent. Hooks surface all Goals assigned
  to the calling chat without requiring work selection; Pause preserves held input.
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

A project hook exposes pending feedback from every Goal assigned to the calling
chat, including before work selection and during Auto mode continuation. Each
entry identifies its Root and Goal path so the agent can read it in context.
Choosing a work Goal does not filter the inbox. Other chats and subagents cannot
claim that inbox; manually held feedback keeps its pause/resume delivery path.

For a separate request that should wait, `goal activity --event <ID> --state
deferred` records reading while retaining a verified native queue entry. It is
available only to the assigned chat during another active turn, before claiming
the request. Missing or uncertain queue state is an error, not a promise to deliver
later. It does not create a Goal or change the selected work. Repeated hooks in
the same turn stay quiet; a later turn can surface still-pending input again.

The native queue remains a fallback until the agent claims the feedback
with `goal activity --event <ID> --state working`. That receipt removes only
matching chill-agent queue entries. Simply showing a hook notice consumes nothing.

Read all delivered messages, apply later corrections, and skip already completed
events. When the requested work is finished, record `completed`; use `failed` if
it could not be completed. An activity receipt does not select a work Goal or
mark a Goal Done. See [execution state](execution-state.md).

## Read the handoff

Delivery keeps the user's original text, annotations, attachments and event IDs
separate from the protocol. The handoff supplies receipt commands and a
`show --section context --since ...` command, which keeps the current agreement
and all subsequent input while linking to larger bodies. A held bundle uses
its earliest event as the reading boundary so later corrections stay visible.

Applications can supply a packaged [agent guide](../extensions/agent-guidance.md).
The delivery points to that entry instead of repeating its policy. The standalone
CLI provides a short fallback for work selection, replies and completion; it
does not require an application skill.

## Current Activity

The Agent panel shows the current status and a link to the work Goal. If the
exact work Goal is unavailable, it labels a link to the connected Root Goal.
It does not fetch or display message bodies. Its Pause/Resume controls target the exact observed
chat and turn, including autonomous work with no feedback receipt. Native
connections without verified execution controls omit those buttons.

A manual pause prevents Auto mode from sending another continuation while that
run remains stopped. Resume continues the same interrupted work; turning Auto
mode off is a separate preference. Uncertain control results require refresh,
not an automatic retry. Historical logs remain available through their existing
API and Conversation records.

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
See [model settings](model-settings.md) for the adapter boundary and save checks.

Implementation: [delivery](../../lib/delivery.mjs),
[held feedback](../../lib/feedback-hold.mjs), [controls](../../lib/agent-status.mjs).
