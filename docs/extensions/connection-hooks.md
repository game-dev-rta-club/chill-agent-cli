---
keyPoints: >-
  Trusted composed extensions may confirm native actions and return a continuation
  from a verified main Stop. Policy owns durable reservations; the CLI owns identity,
  hook output and coordination with feedback. This does not establish live control.
---

# Extend a verified native connection

Protocol v1's optional `connection-hooks` capability lets a packaged extension
participate in the experimental [Claude main-hook protocol](../agent/claude-actions.md).
The standalone CLI contains no Auto mode policy. Register trusted modules in the
composed runtime's `extensions.json`:

```json
{"connectionExtensions":{"example":"./lib/example-connection.mjs"}}
```

Modules must resolve inside that runtime, including after following symlinks.
Workspace content and hook payloads cannot choose executable paths.
`CHILL_AGENT_EXTENSIONS=none` disables this loading. Native hook configuration
remains a separate opt-in; declaring a provider does not install hooks.

## Confirm an action

An extension command calls `requestNativeAction('extension', {extension,
operation, input})` and prints the returned marker. The shell only stages intent.
The main Bash hook validates session, context and generation, then invokes:

```js
export async function confirmAction({requestId, connection, generation,
  promptId, operation, input}) {
  // Validate ownership and payload; persist an idempotent effect.
  return {result: {saved: true}, context: 'The confirmed result for the Agent.'};
}
```

Require `promptId` when the action needs native prompt evidence. Validate the
provider's payload; the host only bounds its JSON size and envelope. Subagents
cannot confirm actions. A completed request is silent on replay. A deliberately
recovered incomplete request keeps its ID, so the provider must make its mutation
idempotent across a crash between its write and the host's completion record.

## Decide at a verified Stop

`onStop({connection, generation, promptId, checkpointId})` runs under the native
entry lock after a verified main prompt ends. Return `null` to abstain or a reason
string to continue. The host emits native `decision: "block"` once, removes the
idle checkpoint and cancels its optional watcher. The next ordinary tool in the
same continued prompt can receive saved Web feedback again; a repeated Stop
without intervening tools does not create another checkpoint.

Persist a reservation **before** returning a reason. A lost hook output is an
uncertain request, not permission to resend. Each provider owns its allowance,
Off/Pause handling, result receipts and reconciliation. A result alone is not
proof of response completion; a matching later main Stop can supply that fact.
An unresolved request must not be bypassed through another Root in the same chat.

The optional idle watcher uses the same checkpoint. If it offers Web input first,
the continuation policy must observe that pending delivery and abstain. If the
synchronous continuation wins, the removed checkpoint cancels the watcher.
There is no second transport fallback or new Agent process.

Use `connectionPolicyLock(connection, run)` to serialize a native policy journal.
`continuationWorkspace(rootId)` supplies saved Goal, Brief and user-input revisions,
not live execution facts. `readDeliveryState` and `readFeedbackHold` let policy
check saved input across the connection. Do not call entry-locking native actions
from inside these callbacks. Native queue state, permissions and interruption
remain Claude's responsibility; a Stop is not a general live-status signal.

Implementation: [provider loading](../../lib/connection-extensions.mjs),
[main-hook coordination](../../lib/claude-actions.mjs). Product-specific commands
and qualification belong to the integrating extension's documentation.
