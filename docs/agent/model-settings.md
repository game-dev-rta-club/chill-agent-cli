---
keyPoints: >-
  A native adapter supplies model choices and normalized settings. Shared caching
  and save validation are isolated per harness conversation; stale or unconfirmed
  changes never become successful saves. Only Codex Desktop is currently connected.
---

# Read and change the connected model

The Agent menu shows the model in the connected conversation. Model choices and
reasoning levels come from that connection; choosing a model does not choose a
harness or move the Goal into another conversation. Currently the only runtime
connection is Codex Desktop.

The implementation separates three responsibilities:

| Layer | Responsibility |
| --- | --- |
| [Connection selection](../../lib/agent-connection.mjs) | Resolve the Root's existing chat binding. A legacy `threadId` means Codex Desktop. |
| [Native adapter](../../lib/codex-desktop-connection.mjs) | Read native data, return supported model IDs and labels, probe available operations, and perform a conditional settings change. |
| [Settings store](../../lib/agent-settings.mjs) | Cache snapshots per harness and conversation, reject competing saves, validate choices and expected values, then verify the result. |

The [Agent status service](../../lib/agent-status.mjs) joins these settings with
Goal activity and queue labels for the existing Web response. Delivery, live
run observation and Pause/Resume still use the Codex integration; separating
settings alone does not make another harness usable.

## A save needs fresh evidence

The UI sends its selected values and the values it originally displayed. The
store reads a fresh snapshot, checks the choice against the adapter's options,
checks the original values and write capability, and verifies Goal ownership
before writing. The adapter must apply the original values as a condition at
the native write boundary. A prior read by itself cannot prevent a concurrent
change in the harness UI.

After the write, the store reads again and rechecks ownership. A rejected write,
changed owner, failed read or mismatched result is not reported as success.
Unconfirmed saves are not automatically repeated. Concurrent saves for the same
harness conversation are rejected while independent connections can proceed.

Snapshots expire after ten seconds. A failed read invalidates its own cached
entry without deleting a newer refresh. Native usage failures remain unavailable
rather than hiding other data or becoming zero usage. The adapter returns queue
message identities for matching Goal labels, not private prompt bodies.

See the [connection proposal](harness-connections.md) for the remaining work to
support another harness, including binding, feedback delivery and idle wake.
