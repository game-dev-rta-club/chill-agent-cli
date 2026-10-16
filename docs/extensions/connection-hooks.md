---
keyPoints: >-
  Trusted composed extensions may run actions for a Claude conversation and
  return a continuation from its main Stop. Policy owns durable reservations;
  the CLI owns identity, hook output and coordination with feedback. This does
  not establish live control.
---

# Extend a verified native connection

Protocol v1's optional `connection-hooks` capability lets a packaged extension
participate in the experimental [Claude connection](../agent/claude-actions.md).
The standalone CLI contains no Auto mode policy. Register trusted modules in the
composed runtime's `extensions.json`:

```json
{"connectionExtensions":{"example":"./lib/example-connection.mjs"}}
```

Modules must resolve inside that runtime, including after following symlinks.
Workspace content and hook payloads cannot choose executable paths.
`CHILL_AGENT_EXTENSIONS=none` disables this loading. Native hook configuration
remains a separate opt-in; declaring a provider does not install hooks.

## Run an action

An extension command calls `runNativeAction('extension', {extension,
operation, input})` and prints the returned `text`. The host finds the calling
conversation, as it does for every Claude command, then invokes:

```js
export async function confirmAction({requestId, connection, generation,
  promptId, operation, input}) {
  // Validate ownership and payload; persist the effect.
  return {result: {saved: true}, context: 'The result for the Agent.'};
}
```

`promptId` is null: a shell command has no native prompt identity. Validate the
provider's payload; the host checks only its envelope.

## Decide at Stop

`onStop({connection, generation, promptId, checkpointId})` runs under the native
entry lock when a main response ends; a subagent Stop never calls it. Return
`null` to abstain or a reason string to continue. The host emits native
`decision: "block"` with a fresh checkpoint ID each Stop; the provider's own
reservation decides whether a repeated Stop continues again.

Persist a reservation **before** returning a reason. A lost hook output is an
uncertain request, not permission to resend. Each provider owns its allowance,
Off/Pause handling, result receipts and reconciliation. A result alone is not
proof of response completion; a later main Stop supplies that fact.
An unresolved request must not be bypassed through another Root in the same chat.

Saved Web input that the [watcher hook](../agent/claude-wait.md) has detected
stays pending until a hook or the inbox offers it, so the continuation policy
must observe that pending delivery and abstain. There is no second transport fallback or new
Agent process.

Use `connectionPolicyLock(connection, run)` to serialize a native policy journal.
`continuationWorkspace(rootId)` supplies saved Goal, Deliverable and user-input revisions,
not live execution facts. `readDeliveryState` and `readFeedbackHold` let policy
check saved input across the connection. Do not call entry-locking native actions
from inside these callbacks. Native queue state, permissions and interruption
remain Claude's responsibility; a Stop is not a general live-status signal.

Implementation: [provider loading](../../lib/connection-extensions.mjs),
[Claude actions and hooks](../../lib/claude-actions.mjs). Product-specific commands
and qualification belong to the integrating extension's documentation.
