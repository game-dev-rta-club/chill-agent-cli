# Extension API v1

Import only `@game-dev-rta-club/chill-agent-cli/extension-api` and call
`requireProtocol(1)` before work. The host is trusted code, not a sandbox.

- `observe(rootId, pending?)` reads assigned chat, native queue, manual pause,
  feedback delivery, content revision, and pending request execution evidence.
  New observations also include `context.goals`: subtree totals, unfinished count,
  display-state counts and own unanswered Letter totals, including the root.
  This additive field indicates support for compact `goal review` filters;
  consumers using older v1 releases can fall back to `goal tree`.
- `eligibility(facts)` returns idle only on positively confirmed completed work.
- `enqueue(facts, text, requestId)` locks execution, observes again, validates
  assignment/revision/turn and reserves the UUID before enqueue. Repeated IDs
  return the saved receipt; uncertain receipts are never resent.
- `storage(namespace)` returns read/write for extension-owned journals. `policyLock`
  serializes policy operations separately from the execution lock.
- `listGoals`, `readGoalContext`, `touch`, `dataDirectory` and ID validators
  provide host-owned workspace access and lifecycle operations.

A composed runtime supplies `extensions.json` with relative `modules` and optional
`commands`. Modules export `createExtension()`. The returned object has an `id`,
`label`, and optional start/tick/stop/busy methods plus read/set for Web controls.
The host serializes ticks every 30 seconds. CLI-only distributions omit the manifest.
Do not import private library files or inspect the CLI's storage directly.

## Controls and activity in the Agent menu

`read(goalId, {activity: true})` may add an `activity` descriptor to its control:

```js
{label: 'AutoContinue', status: 'Off', checkedAt: '2026-10-05T00:10:00Z',
 activeCount: 0, total: 1, entries: [{id: 'stable-entry-id', at: '2026-10-05T00:09:00Z',
 summary: 'Check for anything missed in the completed Goals.',
 message: 'The exact request text', status: 'Result received',
 result: {label: 'No work reported', at: '2026-10-05T00:10:00Z'}}]}
```

GET `/api/goals/:id/extensions?activity=1` requests these details. Normal header
reads omit them. Entries are newest first, bounded by the extension (continuation
returns the latest 20); `total` exposes omitted older records. The host renders
plain text only, with the optional `activeCount` for pending/running checks and
expandable history after Activity and Queue. Zero active checks displays `Empty`,
even when history exists. Completed checks and received results do not contribute
to `activeCount`; `total` describes history only. The control icon with an On/Off label toggles enablement
without opening history and shares its state with the header control. The collapsed
section uses two rows, with History beneath the control.
POST `/api/goals/:id/extensions/:extension?activity=1` saves enablement and returns
controls with fresh activity snapshots, so a menu save retains the history.
Use `message: null` when the exact old text was not saved; do not reconstruct it.
Keep current enablement separate from each historical request and result. Reads
must not create Conversation events, reset counters or cause new requests.

The header's Agent presence is host-owned, independent of extension state, and
read through GET `/api/goals/:id/agent/presence`. It uses the assigned chat's current
turn, manual-pause evidence and fresh chat heartbeat, including runs with no user
feedback receipt or selected Goal. Goal execution uses the same observation and
state resolver; only the selected Goal and its ancestors show Running. Missing evidence displays unavailable, not idle. Header refreshes
do not request settings or account usage and do not renew the server lease.
