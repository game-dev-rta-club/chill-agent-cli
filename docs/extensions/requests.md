---
keyPoints: >-
  Observe first, then enqueue through a lock and fresh validation. A request ID is
  reserved before delivery; uncertain receipts must not be retried under a new ID.
---

# Request work from a confirmed idle chat

An execution policy decides whether more work is useful. The host decides whether
it can safely enqueue that request. Use the public extension API for both the
observation and the send; a previously observed idle chat is not a reservation.

```js
import { randomUUID } from 'node:crypto';
import { requireProtocol, observe, eligibility, enqueue }
  from '@game-dev-rta-club/chill-agent-cli/extension-api';

requireProtocol(1);
const facts = await observe(rootId);
if (eligibility(facts) === 'idle') {
  const requestId = randomUUID();
  // Persist this ID and the policy decision before the send.
  await enqueue(facts, 'Continue the agreed work if anything remains.', requestId);
}
```

This illustrates the boundary, not a complete retry loop. A durable policy must
save its pending request, recover it after a restart, and reconcile uncertain
outcomes before deciding to send anything else.

## What the observation establishes

`observe(rootId, pending?)` requires an assigned root. It reads current Goal/Canvas
content, unanswered Letters, user feedback, chat execution, the complete native
queue, pause evidence and recent work heartbeat. It checks the latest turn again
after reading the queue so a changing turn cannot appear idle.

`eligibility(facts)` excludes manual pauses, unprocessed feedback, queued work,
an active or unfinished run, and unknown or changing observations. Idle requires
positive evidence of a completed or failed latest turn. An empty queue or missing
turn by itself is insufficient. Done Goals and unanswered Letters are context
for policy, not host-level reasons to suppress a request.

The `revision` covers the root subtree's Goal content, latest Canvas bodies and
latest user-feedback change. Agent comments, execution bookkeeping and a policy's
internal results do not reset it. `context.goals` adds compact subtree counts for
current hosts; older protocol-v1 hosts may lack that optional field. Consumers
should check for it before choosing newer reader commands.

## Coordinate and recover

`enqueue(facts, text, requestId)` takes the same chat lock used by controls,
observes again, and compares the assignment, revision, turn and eligibility.
Changed evidence rejects the send. It reserves the UUID before adding to the
native queue, then saves the receipt. Reusing the same ID returns its saved
receipt when available; different root/text is rejected. A reserved ID without
a receipt is uncertain and is not resent.

`observe(rootId, {id, at})` can inspect a pending request's execution evidence.
Turn history finds it by the request ID: the queued input comes back as the
turn's user message with that ID as its `clientId`. `pendingWork.endedAt` is the
evidence that the run ended; a policy records its own result from it (the
continuation policy compares a `progress` mark saved at send time).

Keep execution evidence distinct from the policy's own result. Store
the policy journal with `storage(namespace)` and serialize policy decisions with
`policyLock(threadId, run)`. These are separate from the host's enqueue lock.
`listGoals` and `readGoalContext` provide workspace facts; `touch()` records
genuine use when needed, not routine polling.

For an on-demand public log of a Codex chat, `readRunOutput({threadId, id, at, turnId?})`
uses the same turn reader without observing scheduling eligibility or enqueueing.
Pass only a request from the extension's own saved journal after checking the
current Root owner. Keep its Goal association at send time; do not derive an old
run's target from today's work selection. Public messages and turn settings are
returned, never private reasoning or tool input/output.

Implementation: [request reservation](../../lib/extension-api.mjs),
[observation](../../lib/agents/codex-continuation-observation.mjs), [eligibility](../../lib/continuation-eligibility.mjs).
