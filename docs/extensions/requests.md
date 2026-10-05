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

`observe(rootId, pending?)` requires an assigned root. It reads current Goal/Brief
content, unanswered Letters, user feedback, chat execution, the complete native
queue, pause evidence and recent work heartbeat. It checks the latest turn again
after reading the queue so a changing turn cannot appear idle.

`eligibility(facts)` excludes manual pauses, unprocessed feedback, queued work,
an active or unfinished run, and unknown or changing observations. Idle requires
positive evidence of a completed or failed latest turn. An empty queue or missing
turn by itself is insufficient. Done Goals and unanswered Letters are context
for policy, not host-level reasons to suppress a request.

The `revision` covers the root subtree's Goal content, latest Brief bodies and
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
Current turn-history matching needs either a `[chill-agent:<request-id>]` marker
in the message or the continuation policy's exact result-command line. An
arbitrary message is not automatically traceable after leaving the queue; a
different policy must account for this before relying on `pendingWork`.

Keep execution evidence distinct from the agent's reported policy result. Store
the policy journal with `storage(namespace)` and serialize policy decisions with
`policyLock(threadId, run)`. These are separate from the host's enqueue lock.
`listGoals` and `readGoalContext` provide workspace facts; `touch()` records
genuine use when needed, not routine polling.

Implementation: [request reservation](../../lib/extension-api.mjs),
[observation and eligibility](../../lib/continuation-observation.mjs).
