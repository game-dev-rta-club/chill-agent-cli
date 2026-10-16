---
keyPoints: >-
  Experimental Claude Auto mode continues through a main Stop, once per
  meaningful revision. It preserves Off, continuation Pause, pending feedback and
  uncertain reservations. Native packaged qualification passes; explicit project hook setup is available.
---

# Qualify Auto mode in a Claude conversation

This development route uses the same Auto mode guidance and revision allowance
as Codex, but a different native delivery mechanism. The built-in continuation extension registers
[claude-continuation](../../lib/claude-continuation.mjs) through the optional
`connection-hooks` capability. Codex remains the default setup route. Experimental native project hooks
use explicit `setup prepare --harness claude-code --project /absolute/project`.
Setup does not enable Auto mode or change native permissions. This route is not
advertised as a supported Claude Web control, apart from the AutoContinue switch below.

Prepare the composed runtime in an isolated data directory. Configure the CLI's
`connection claude-hook` for SessionStart, UserPromptSubmit, PostToolUse, Stop and
SessionEnd. Create a new Root with connection create-goal. In that same
main conversation, using the prepared launcher:

```sh
chill monitor enable --id <ROOT>
chill monitor disable --id <ROOT>
chill monitor pause --id <ROOT>
chill monitor resume --id <ROOT>
```

Each command acts at once for the calling conversation. `pause` holds **future automatic
continuations**; it does not interrupt Claude. Enabling does not release a pause
or reset history. The existing Web polling scheduler, `start`, `tick` and `watch`
do not drive this experimental route. No new native process is launched.

## Switch it from Web

The Agent menu of a Claude Root shows the same AutoContinue switch as a Codex
Root. Switching it is the user's own action, so it needs no native prompt; it
always writes the setting for the Root's current conversation. Like `enable`,
switching it On keeps a Pause, the history and the revision allowance. Its status
is read from the saved record (Watching, Paused, Awaiting confirmation, Delivery
pending, Checks complete or Agent changed); it does not go stale between Stops.
The Web log of a run shows the saved request; Claude's own output stays in its
conversation. Pause/Resume remain conversation commands.

When a continued conversation takes a Root over with `connection adopt`, its
On/Off and Pause move to the new conversation, because they describe the Goal's
work rather than one session. A request the earlier conversation never answered
is closed as Agent changed and never resent. The Root's owner is part of the
revision, so the new conversation receives its own single check, as a reassigned
Codex Root does. A record of an owner the Root never had reads as Off and is not
overwritten.

## Continue once and account for the result

At a main Stop, the extension checks saved feedback and holds across
every Root in this native connection. Off, Pause, unprocessed input and uncertain
prior requests suppress continuation. The extension saves one attempt before the
CLI returns a native Stop decision. It links the packaged combined continuation
and stopping-review guide, without claiming that native input queues are empty.
Claude retains its input ordering and tool permission policy.

The Agent reports the exact attempt through `monitor result`; the response must
then reach a Stop. Only both facts complete the attempt. A lost output or missing receipt is never
blindly retried, even after a revision change or through another Root. One check
consumes the allowance for that revision; comments, results and Off/On toggles
do not create another allowance. Substantive Goal, Deliverable or user-input changes
can create the next one after the preceding attempt is resolved.

Saved Web feedback detected by the CLI reply waiter stays pending until the inbox
claims it, so a pending reply makes Auto mode abstain at Stop. A continuation
removes its old checkpoint. The continued prompt receives new Web replies at its
next ordinary tool hook, preserving uncertain-offer deduplication.

## Reproduce the native check

From this checkout, after `npm ci`:

```sh
node scripts/probe-claude-auto.mjs --run --runtime "$PWD" --auth-settings /absolute/path/to/native-settings.json
```

The probe copies the runtime to a disposable data directory and uses its
stable launcher. It creates a Root, enables Auto mode and finishes the initial
response. The native Stop continues that same process; the Agent reads the Goal
index/context, retains an initial memory token and reports the attempt. A second
Stop consumes it without another nudge. The script limits print-mode model cost
to $0.75 and runtime to 120 seconds, imports explicit native authentication only
into memory, and removes temporary files. It does not alter ordinary settings.

Claude Code 2.1.289 passed all 13 checks on 2026-10-06. The continuation kept the
same native prompt ID and needed no new user input. Local tests additionally cover
concurrent/repeated Stops, Off/Pause, pending input in other Roots, resumed feedback,
subagents, clear, unknown output and delayed receipts.

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
