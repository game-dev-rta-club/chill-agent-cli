---
keyPoints: >-
  Queue and Checking share the Running visual. Activity can override a Done badge
  without changing completion. Observations are cached per harness and session;
  missing or failed evidence never proves a chat is idle.
---

# Separate activity from completion

A Goal's stored state answers whether its outcome is complete. Live activity
answers whether its agent has work in flight. A Done Goal receiving new feedback
can show Running and return to Done when the work ends; its saved state and
progress do not change just because activity was observed.

Select the current work with `chill goal work --id <ID>`. This binds one Goal to
the assigned chat's current unfinished turn. A new turn needs a new selection;
publishing a Brief or acknowledging feedback does not switch it. Reopen a Done
Goal or resolve Waiting to `idle` before selecting it. `work --stop` stops tracking
the selection; it is not the Web control that interrupts the agent.

## What the Web shows

| Signal | Meaning |
| --- | --- |
| Running | Working, queued or checking pending work; the rotating indicator groups these together |
| Paused | Confirmed manual stop or held feedback for that Goal |
| Idle | The chat's observed execution has ended, with no pending display activity |
| Unavailable | The connection or evidence cannot establish the current state |

The header describes the assigned chat, even before a work Goal is selected.
Goal rows use the selected work and their own feedback activity; unrelated Goals
do not all become Running merely because they share a chat. Running propagates
to ancestors and takes display priority over Done. Parent completion still
requires the [explicit lifecycle checks](../workspace/goals.md).

Native turn state, queue, control records and fresh hook heartbeats contribute
to the observation. A heartbeat can confirm an unfinished run that the Desktop
reports as unloaded; it cannot revive a turn whose end is confirmed. Stale or
failed observations are not proof of idle, and cached observations expire.

The connection adapter supplies these observations. For Codex Desktop it reads
the native thread, latest turn and queue through one connection, checks the
returned thread identity, and combines the result with Codex's control record
and heartbeat. It keeps conversation content out of the observation snapshot.

The shared cache keys observations by **harness and session**, so two providers
using the same session ID cannot share a run, pause or heartbeat. A fresh read
can replace an in-flight read; failure of the older one cannot discard that
newer result. An unsupported observer yields Unknown. A failed read is not
replaced with the previously cached Idle state. Current Root assignments and
control/delivery paths still support Codex only; this boundary does not enable
a Claude connection by itself.

The header uses a lightweight presence read. Opening the Agent menu separately
loads model settings, usage and queue details. Extension enablement and its
history do not define the agent's live state. Policies that send new work must
use [execution eligibility](../extensions/requests.md), not interpret a UI label.

Implementation: [shared observation](../../lib/agent-observation.mjs),
[Codex adapter](../../lib/codex-desktop-connection.mjs),
[Goal overlay](../../lib/agent-activity.mjs), [display priority](../../public/goal-state.js).
