# Extension API v1

Import only `@game-dev-rta-club/chill-agent-cli/extension-api` and call
`requireProtocol(1)` before work. The host is trusted code, not a sandbox.

- `observe(rootId, pending?)` reads assigned chat, native queue, manual pause,
  feedback delivery, content revision, and pending request execution evidence.
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
