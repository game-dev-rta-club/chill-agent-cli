---
keyPoints: >-
  A Claude conversation gets the end-of-turn check its Roots' Autonomy asks for
  at its main Stop, once per meaningful revision; a level change is a revision.
  It respects pending feedback and the revision allowance. The request is the
  same one Codex gets and names no command; the next Stop ends it and chill
  records whether the agent left anything on the Web. Nothing is reported.
---

# Qualify the end-of-turn check in a Claude conversation

This development route uses the same request, result recording and revision
allowance as Codex, but a different native delivery mechanism. The built-in
continuation extension registers [claude-continuation](../../lib/claude-continuation.mjs)
through the optional `connection-hooks` capability. Codex remains the default
setup route. Experimental native project hooks use explicit
`setup prepare --harness claude-code --project /absolute/project`. Setup leaves
every Root at Autonomy Normal and does not change native permissions.

What the check asks follows the
[Autonomy](../workspace/goals.md#autonomy-how-far-the-agent-goes-on-its-own)
of each Root the conversation owns, set from any of its Goals' comment boxes.
There is no other switch: the AutoContinue and Approve all controls and
`chill monitor enable|disable|pause|resume` were removed.
`chill monitor status --id <ROOT>` prints a Root's check record.

## Which Roots, and which Root keeps the record

The conversation's levels are those of the Roots it owns. At a main Stop with
nothing left to hand over, the extension builds one message from the highest
level among its unfinished Roots; with none above Normal, it sends nothing. The
Root at the highest level keeps the attempt in its journal
(`workspace/continuation/<root>.json`), which holds the Root agent's level,
attempts, history and the revision.

When a continued conversation takes a Root over with `goal adopt`, it
keeps the journal and its level; a request the earlier conversation never
answered is closed as Agent changed and never resent. The Root's owner is part
of the revision, so the new conversation receives its own single check, as a
reassigned Codex Root does. A record with no owner yet (a level set before any
conversation worked on the Root) is taken over the same way. A record of an
owner the Root never had starts over at Normal and keeps its history.

## Continue once; chill records the result

At a main Stop, the extension checks saved feedback and holds across every Root
in this native connection. Unprocessed input suppresses continuation. The
extension saves one attempt before the CLI returns a native Stop decision,
without claiming that native input queues are empty. Claude retains its input
ordering; tool prompts follow Autonomy (every owned Root at Auto Continue or Ultra Continue).

The request lists the owned Roots above Normal by level name with what each
asks, so it stands on its own: the agreed work anywhere under the Root (Auto
Continue), or the whole Root tree toward its criteria, without Goals other live
conversations work on (Ultra Continue).
It lists what the record already says (unfinished Goals, feedback still awaiting
a reply, open Letters) and names no command, so a turn with nothing left ends in
a single response. Codex receives the same text; only a conversation that can
schedule its own wake-up also hears about `agent wake`.

The request goes out as Stop output, so the next main Stop means the response
that received it has ended. That Stop ends the attempt and records its result:
`worked` when the agent left something on the Web since the request (a comment,
a Letter, or a Goal or Deliverable change), otherwise `no-work`. The agent
reports nothing. A Codex run is recorded the same way when chill sees the turn
that received the request end. One check consumes the allowance for that
revision, so the same revision is never continued twice; comments and results do
not create another allowance. Substantive Goal, Deliverable, user-input or
Autonomy changes create the next one. One Stop sends at most one request for the
conversation.

Saved Web feedback detected by the watcher stays pending until a hook or the inbox
claims it, so a pending reply makes the check abstain at Stop. A continuation
removes its old checkpoint. The continued prompt receives new Web replies at its
next ordinary tool hook, preserving uncertain-offer deduplication.

## Reproduce the native check

From this checkout, after `npm ci`:

```sh
node scripts/probe-claude-auto.mjs --run --runtime "$PWD" --auth-settings /absolute/path/to/native-settings.json
```

The probe copies the runtime to a disposable data directory and uses its
stable launcher. It creates a Root, sets its Autonomy to Auto Continue and finishes the initial
response. The native Stop continues that same process; with nothing left to do,
the continued response retains an initial memory token and ends in one line
without tool calls. A second Stop ends the attempt without another nudge, and
chill records its `no-work` result itself (`result.observed`). The script limits print-mode model cost
to $0.75 and runtime to 120 seconds, imports explicit native authentication only
into memory, and removes temporary files. It does not alter ordinary settings.

Claude Code 2.1.289 passed all 13 checks on 2026-10-06, when the continued
response still read the Goal and reported its result; the current checks
(`continuedWithoutTools`, `resultObserved`) have not been run since. The continuation kept the
same native prompt ID and needed no new user input. Local tests additionally cover
concurrent/repeated Stops, Autonomy levels, pending input in other Roots, resumed feedback,
subagents, clear, unknown output and delayed replies.

The additional `--setup-resume` probe first saves an earlier conversation without
chill hooks ($0.15/45-second bound), installs experimental project hooks through
the packaged setup command, and resumes that same native session. On the same
version/date all 15 checks passed, including the earlier memory token, one Root,
one continuation and preservation of unrelated local settings. The default
$0.75/120-second bound applies to the resumed phase. The initial test allow rule
needed command-quoting alignment; native permissions were not broadened.

These checks qualify disposable print-mode flows, not permanent idle delivery,
hot-installation into a running conversation, general execution cancellation or
production setup. Those remain separate work. The boundary contract is the
[connection-hook guide](../extensions/connection-hooks.md).
