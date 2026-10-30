---
keyPoints: >-
  Claude connection commands act at once for the conversation Claude Code names
  in its shell, as Codex commands do; there is no request marker to confirm.
  Web input reaches a conversation only through its main hooks (tool hooks and
  the watcher), which never run for a subagent. A Goal waits for a reply while
  the user commented after the agent; `reply --goal` answers it. Stop holds a
  response once when a handed Goal still waits for a reply with nothing left
  running. Optional connection extensions run the same way.
---

# Act from a Claude conversation

These development commands extend the [entry handshake](claude-entry.md).
Use the explicit [project setup](claude-setup.md) for experimental native hooks.
Default Codex setup does not install them.

## Commands act at once

```sh
chill goal create --title 'The agreed outcome' --scope 'Scope' --criteria 'Evidence of success'
chill goal inbox
chill goal reply --id 1 --text 'What I did'
```

Use the prepared runtime's `runtime/chill` entry in place of `chill`. Each
command finds its conversation from `CLAUDE_CODE_SESSION_ID`, which Claude Code
sets in every shell, and the recorded entry for it: the current context is
always used, so compact or resume never breaks a running command and a command
after clear acts for the new context. The command does its work and prints the
result, such as `Created Goal #1` or `Replied on Goal #1 (comment 2)`. Its
output can be piped or shortened like any other command.

`reply` posts the answer in the Goal's Conversation. There are no per-comment
receipts: a Goal waits for a reply while the user's latest comment is after the
agent's latest one, so one reply answers everything the user said there.
`goal work --id <GOAL>` marks the Goal the current response works on, as in a
Codex turn; the mark ends with that response.

A subagent shares the conversation's shell environment, so its commands act for
the same conversation. That is the conversation's own work: Codex commands
behave the same way.

This is coordination between trusted same-user processes, not authentication.
Native tool permissions remain with Claude. No permission mode is changed.

## Preserve ownership

A new Root stores its owner as `owner: {agent, id, context}`: for Claude the
agent `claude-code`, the session ID and the context ID. Codex owners have the
same shape without a context. A child inherits its Root, so Goals moved into another Root, even a
whole Root, belong to that Root's owner (see [Move Goals between Roots](../workspace/goals.md#move-goals-between-roots)).
Resume and compact retain the context ID; startup, clear and fork replace it.

When Claude continues a conversation in a new session, for example after its
context limit, the new session owns nothing. If the user asks it to continue a
Goal, it takes the Root over:

```sh
chill goal adopt --id 1
```

The Root and its Split Goals move to the new conversation, the earlier owner is
kept in `previousOwners`, and feedback saved for the earlier owner is delivered
to the new one. Web gets no note of the move: an agent comment would count as a
reply and drop the comments still awaiting one. The earlier owner's watcher
ends when it next finds that conversation owns nothing. `goal adopt` works the
same from any agent and on a Root with no owner; `goal release` leaves a Root
with no owner.

To hand part of a Root to another conversation, first make that Split Goal a Root
of its own (`chill goal update --id 58 --input-file patch.json` with
`{"parentId":null}`). It stays with the same conversation, keeps its Split Goals,
Conversation and Canvases, and starts from the Root's hand-off cursor, so a
comment already handed is not handed again. The other conversation then runs
`chill goal adopt --id 58`.

Each Root keeps one hand-off cursor: the last user comment handed to the
conversation that owns it. Comments after the cursor wait; handing them moves
the cursor forward, so nothing is handed twice. `inbox` hands what waits and
lists the handed comments whose Goals still wait for a reply; the ones handed
earlier, by a hook or the watcher, are listed apart from the new ones. Pause from the
Web holds everything until Resume. It never falls back to Codex or another
transport.

## Receive feedback through hooks

Every main-session PostToolUse hook hands newly saved Web replies across all
of the conversation's Roots, without an `inbox` call. Feedback saved while the
conversation's own work runs waits until that work ends, unless the user
presses Send now. The hook reads its input whatever its size, so a tool result
with images never stops delivery.

The main hooks also record what the conversation is doing: UserPromptSubmit and
the tool hooks start its work, a Stop that lets it end finishes it, StopFailure
or an Esc interrupt in the transcript interrupts it, and SessionEnd ends the
conversation. Work that writes nothing for 30 minutes is shown as unknown.

Every conversation in the project runs these hooks, including those that never
use chill. One that has never owned a Root Goal is marked quiet
([claude-quiet](../../lib/claude-quiet.mjs)), and the `chill` launcher ends its
later hooks before Node starts, as if chill were not installed. SessionStart
always runs and decides again. The marker is cleared when the conversation
creates or adopts a Goal, under the same lock, so a conversation can start using
chill at any point and an owner is never left quiet.

Background tasks keep the conversation Running after its response ends. The
Stop hook records the tasks Claude Code lists as still running, except shells.
A subagent's own hooks keep that list current between Stops. SubagentStart adds
the subagent, each tool it uses marks it active, and SubagentStop removes it. A
task that ends without a hook, such as a stopped subagent or a monitor, is
removed when its task notification appears in the transcript. The Goal shows
**Background** with each task, and a list with no activity for 30 minutes as
unknown.

Subagent hooks never hand feedback: a subagent that received it would end with
it, and the main conversation would never see it. Replies after a response ends
reach the conversation through the [watcher hook](claude-wait.md).

When a response ends, the Stop hook applies the shared
[quiet-stop rule](feedback-and-controls.md#when-the-agent-stops): if a Goal it
was handed feedback on still waits for a reply and has had no Comment since it
last stopped, and Claude Code lists no background work in the Stop input's `background_tasks`
(chill's own `agent wait` task does not count), the hook blocks once and
asks the agent to reply or post a progress comment. The stop right after that
hold ends. A trusted composed
[connection extension](../extensions/connection-hooks.md) may separately request
a continuation at Stop. UserPromptSubmit, Stop and SessionEnd record the last
hook for the Web status.

## Verify the boundary before enabling a real session

Local tests cover main/subagent separation for delivery, separate contexts,
resume/clear, all-Goal input, holds, replies, Stop and unchanged Codex
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
make a Root, and verify the reply on its Goal and retention of an initial context
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
in the [setup guide](claude-setup.md). The end-of-turn check (Autonomy) has passed its
separate native Stop probe through [connection hooks](../extensions/connection-hooks.md).
Replies after a response ends use the [watcher hook](claude-wait.md). See the
full [connection criteria](claude-conversation.md#qualify-before-exposing-controls).
