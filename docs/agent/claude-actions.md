---
keyPoints: >-
  Claude connection commands act at once for the conversation Claude Code names
  in its shell, as Codex commands do; there is no request marker to confirm.
  Web input reaches a conversation only through its main hooks (tool hooks and
  the watcher), which never run for a subagent. Stop names feedback left
  without a reply once. Optional connection extensions run the same way.
---

# Act from a Claude conversation

These development commands extend the [entry handshake](claude-entry.md).
Use the explicit [project setup](claude-setup.md) for experimental native hooks.
Default Codex setup does not install them.

## Commands act at once

```sh
chill connection create-goal --title 'The agreed outcome' --scope 'Scope' --criteria 'Evidence of success'
chill connection inbox
chill connection reply --event 1 --text 'What I did'
```

Use the prepared runtime's `runtime/chill` entry in place of `chill`. Each
command finds its conversation from `CLAUDE_CODE_SESSION_ID`, which Claude Code
sets in every shell, and the recorded entry for it: the current context is
always used, so compact or resume never breaks a running command and a command
after clear acts for the new context. The command does its work and prints the
result, such as `Created Goal #1` or `Replied on Goal #1 (comment #2)`. Its
output can be piped or shortened like any other command.

`reply` posts the answer in the feedback's Goal Conversation and records the
completed receipt together. Answering each message as it arrives is fine; when
one answer covers several messages of one Goal, `--event 12,13,14` closes them
together. `goal activity --event 1 --state working`, the same receipt
command Codex uses, records the working receipt (`connection activity` is the
older name and still works). Claude has no native Queue, so `deferred` is
refused. `goal work --id <GOAL>` marks the Goal the current response works on,
as in a Codex turn; the mark ends with that response.

A subagent shares the conversation's shell environment, so its commands act for
the same conversation. That is the conversation's own work: Codex commands
behave the same way.

This is coordination between trusted same-user processes, not authentication.
Native tool permissions remain with Claude. No permission mode is changed.

## Preserve ownership and receipt identity

A new Root stores `connection: {harnessId, sessionId, contextId}` and no Codex
`threadId`. A child inherits its Root. Native-owned trees cannot be moved to
another Root. Resume and compact retain the context ID; startup, clear and fork
replace it.

When Claude continues a conversation in a new session, for example after its
context limit, the new session owns nothing. If the user asks it to continue a
Goal, it takes the Root over:

```sh
chill connection adopt --goal 1
```

The Root and its Split Goals move to the new connection, the earlier one is kept
in `previousConnections`, and feedback saved for the earlier owner is delivered
to the new one. A comment in Web records the move. The earlier owner's watcher
ends when it next finds that conversation owns nothing. Goals that no Claude
conversation owns cannot be taken over.

`inbox` reads unclaimed events across this connection's Goals. Each user event
keeps its original connection and event ID. Manual holds, different contexts
and completed events are excluded. An offer persists `unknown`, `mayHaveSent`
and a stable offer ID; a new `inbox` call shows feedback that has no receipt yet
with the same ID. It never falls back to Codex or another transport.

`activity` records a receipt only for this context's offered event. A completed
receipt cannot regress. There is no failed receipt; an agent that cannot finish
says so in a comment. A receipt does not prove live execution or
complete the Goal.

## Receive feedback through hooks

Every main-session PostToolUse hook offers newly saved Web replies across all
of the conversation's Goals, without an `inbox` call. Offered events are not
offered again automatically. Manual holds, other connections and terminal
receipts stay excluded. The hook reads its input whatever its size, so a tool
result with images never stops delivery.

Subagent hooks never offer feedback: a subagent that received it would end with
it, and the main conversation would never see it. Replies after a response ends
reach the conversation through the [watcher hook](claude-wait.md).

When a response ends while feedback it received has no reply, the Stop hook
blocks once for that feedback and names it, so a forgotten reply is noticed;
work that really continues can simply end again. A trusted composed
[connection extension](../extensions/connection-hooks.md) may separately request
a continuation at Stop. UserPromptSubmit, Stop and SessionEnd record the last
hook for the Web status.

## Verify the boundary before enabling a real session

Local tests cover main/subagent separation for delivery, separate contexts,
resume/clear, all-Goal input, holds, receipts, Stop and unchanged Codex
delivery. They exercise actual CLI stdin/stdout, including piped command output
and large hook inputs, as well as store functions.

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
Replies after a response ends use the [watcher hook](claude-wait.md). See the
full [connection criteria](claude-conversation.md#qualify-before-exposing-controls).
