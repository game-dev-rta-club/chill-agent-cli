---
keyPoints: >-
  Main-hook confirmation creates new Claude Roots and handles explicit inbox reads
  and receipts; their results name the reply waiter when none is running. A
  verified native prompt also receives new feedback through ordinary tool hooks.
  Optional connection hooks support a separately qualified Auto mode extension.
  Live controls remain unavailable.
---

# Confirm an action in the Claude main conversation

These development commands extend the [entry handshake](claude-entry.md).
Use the explicit [project setup](claude-setup.md) for experimental native hooks.
Default Codex setup does not install them. Configure `connection claude-hook` for native `SessionStart`, all `PostToolUse`
events, `UserPromptSubmit`, `Stop` and `SessionEnd` in an isolated session, using the same chill data directory.
The official [PostToolUse contract](https://code.claude.com/docs/en/hooks#posttooluse)
can return `hookSpecificOutput.additionalContext` to that conversation.

## Request, confirm, then use the result

Run one connection action per main-session Bash tool call:

```sh
chill connection create-goal --title 'The agreed outcome' --scope 'Scope' --criteria 'Evidence of success'
chill connection inbox
chill connection reply --event 1 --text 'What I did'
```

Use the prepared runtime's `runtime/chill` entry in place of `chill`.
`reply` posts the answer in the feedback's Goal Conversation and records the
completed receipt in one confirmation; a retry of the same request does not post
twice. `connection activity --event 1 --state working|failed` records other
receipt states, for example before long work.
Each command saves an intent and prints a request marker; this is not success.
The main Bash PostToolUse hook checks the saved intent against the current native
session, context and generation, then returns the created Goal ID, saved feedback
or receipt. Subagent hooks cannot commit an intent merely because their shell
inherited the main session's environment. Other tools cannot confirm actions;
interrupted Bash calls are ignored. Normal Goal read, Brief and Comment commands remain usable.
`goal work` and live execution tracking are still Codex-specific.

This is coordination between trusted same-user processes, not authentication.
The marker is a local capability backed by a saved request; do not treat parsing
arbitrary terminal output as proof of user authorization. Native tool permissions
remain with Claude. No permission mode is changed by this protocol.

## Preserve ownership and receipt identity

A new Root stores `connection: {harnessId, sessionId, contextId}` and no Codex
`threadId`. A child inherits its Root. Existing Roots cannot be reassigned through
these commands, and native-owned trees cannot be moved to another Root. Resume
and compact retain the context ID; startup, clear and fork replace it. Every
SessionStart rotates the shell generation, so old shell intents need explicit
recovery even when the context is retained.

`inbox` reads up to ten unclaimed events across this connection's Goals. Each
user event keeps its original connection and event ID. Manual holds, different
contexts and completed/claimed events are excluded. Offering context persists
`unknown`, `mayHaveSent` and a stable offer ID before hook stdout; a missing output
does not count as a receipt. A deliberate new `inbox` call may re-read an unclaimed
offer with the same ID. It never falls back to Codex or another transport.

`activity` confirms a receipt only for this context's offered event. Completed or
failed receipts cannot regress. A receipt does not prove live execution or complete
the Goal. The Agent menu labels the native binding as a development connection;
model settings, usage, live status and controls are not inferred from it.

## Receive feedback during a verified prompt

A successful main-hook action records the native `prompt_id` alongside the
connection generation and context. Ordinary main-session tool hooks in that
prompt can then offer newly saved Web replies across all of its Goals, without
an `inbox` call. Startup identity alone cannot enable this route.

Each tool hook reserves a delivery scan before emitting context. A repeated
hook is silent even when new input has arrived since its first execution.
Different hooks serialize their scans; previously offered events remain
unconfirmed until an Agent receipt and are not automatically offered again.
Manual holds, other connections and terminal receipts stay excluded.

`Stop` clears the verified prompt and leaves a checkpoint for connection
extensions. UserPromptSubmit, SessionStart and SessionEnd also clear old prompt
state; a new prompt or generation needs a fresh confirmed action.
Subagent hooks cannot enable or receive this route. An explicit `inbox` remains
the recovery path for an uncertain offer. This is busy delivery within a verified
prompt; replies after the response ends use the [reply waiter](claude-wait.md). A trusted composed
[connection extension](../extensions/connection-hooks.md) may separately request
continuation at a verified Stop, reserving before output. Its next ordinary tool
resumes feedback delivery in that same prompt.

## Recover an interrupted call

```sh
chill connection request --id <request-uuid>
chill connection request --id <request-uuid> --retry
```

Inspection returns the saved status and result IDs. Retry reuses the same pending
intent, including after a native resume, and needs a new main-hook confirmation.
Creation carries its request ID through the Goal store's lock, so a crash after
writing the Goal cannot create a second one. Completed requests are never
re-executed or used to replay feedback. A repeated hook for a completed intent is
silent. For an inbox output lost after confirmation, deliberately read `inbox`
again; for a receipt already claimed, inspect its event/Goal before resuming work.
Clear/fork cannot recover requests from the previous context.

## Verify the boundary before enabling a real session

Local tests cover main/subagent separation, concurrent and repeated hooks,
interrupted Root creation, request recovery, separate contexts, resume/clear,
all-Goal input, holds, receipts, Stop and unchanged Codex delivery. They exercise
actual CLI stdin/stdout as well as store functions.

The opt-in probe uses temporary settings and data, a fixed allowed Bash runner,
a $0.75 model budget and a 120-second timeout:

```sh
node scripts/probe-claude-roundtrip.mjs --run
node scripts/probe-claude-roundtrip.mjs --run --automatic --auth-settings /absolute/path/to/native-settings.json
```

`--automatic` tests an ordinary tool result receiving synthetic Web feedback
without invoking `inbox`. Both modes create one disposable print-mode conversation,
make a Root, and verify the feedback receipt and retention of an initial context
token. Neither resumes or replaces an existing user conversation.

Isolation excludes normal settings. If native authentication is unavailable,
`--auth-settings` explicitly imports only supported API credentials and their
endpoint/header environment values into process memory, plus the model preference.
It does not import hooks, plugins, permissions or helpers, and does not copy secrets
to temporary settings or reports. The source file is unchanged. Reports contain
selected metadata and checks, not credentials or raw native output. Temporary
files are removed after the run.

On **2026-10-06, Claude Code 2.1.289**, both the explicit-inbox and automatic-tool-hook
probes passed with native authentication. The automatic probe observed one native
prompt through the tool calls and the final Stop; the Agent read the new feedback,
retained its initial context and recorded completion. The earlier `loggedIn: false`
result was caused by excluding user settings containing the credential, not by a
failed native return path.

Native clear/fork behavior and packaged user-facing setup still require
qualification. Explicit project installation is covered separately
in the [setup guide](claude-setup.md). A composed Auto mode extension has passed its
separate native Stop probe through [connection hooks](../extensions/connection-hooks.md).
Replies after a response ends use the [reply waiter](claude-wait.md). See the
full [connection criteria](claude-conversation.md#qualify-before-exposing-controls).
