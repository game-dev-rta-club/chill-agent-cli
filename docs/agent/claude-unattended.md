---
keyPoints: >-
  Before leaving Claude, exercise a Web reply in the same conversation and review
  the native permissions for its actual work. chill Auto mode delegates decisions;
  it does not approve tools. A finite watcher needs the original process awake.
  The Web does not start a closed Claude process. Recover saved replies in the same conversation without duplicate sends.
---

# Leave a Claude conversation working

Use this after [project setup](claude-setup.md), in the same conversation that
owns the Goal. Choose a finite [reply window](claude-idle.md) covering your time
away. Keep that Claude process and computer running. A saved reply can outlive
the window, but the expired watcher cannot wake Claude.

## Understand what remains running

The Web saves messages; the Claude process receives and answers them. The current
integration does not start a closed Claude automatically. A terminal you did not
open yourself may still be running under the agent that prepared a test.

Use one live process for one conversation. Opening another copy with `--resume`
is not an attachment to the existing process. Automatic ownership handoff between
background and interactive use is not implemented. To reopen after exit, use the
same project and session. With the opt-in resume watcher installed, no initial
message is needed; saved feedback is eligible for receipt too.

## Decide what to delegate

There are two independent decisions:

| Setting | What it controls |
| --- | --- |
| chill Auto mode | Whether the agent chooses and carries out the next useful action toward the agreed Goal |
| Claude tool permissions | Which reads, commands and edits can execute without another approval |

In Claude, open `/permissions` and review the operations required by the work.
Saved command-specific allowances can avoid repeated prompts. A one-time approval
does not authorize the next receipt. Native ask or deny rules can override an
allowance. Claude's own permission mode named `auto`, when available, is a separate
native policy; selecting chill Auto mode does not select it.
See [Claude's permission guide](https://code.claude.com/docs/en/permissions).

Use the exact stable command prefix printed by chill setup when reviewing a
command. A rule allowing every `node` or Bash invocation delegates much more
than chill operations. The installer leaves these choices with the user and
does not generate a blanket permission grant.

## Try the work you will actually leave running

Send one small Web request to the Goal after Claude finishes a response, for
example: “Read the current Brief and report one next action; do not change files.”
In that same conversation, check that Claude receives it and completes its
receipt. If Claude asks for a permission, review the actual operation and its
scope there. Do not send the Web request again to clear a permission prompt.

This exercises receipt commands and reading, not permission for future edits,
tests or deployment. Review a representative action from the agreed work before
leaving. If an operation should remain your decision, leave that approval in
place: the affected action may wait while independent work continues.

## Find the reason if progress stops

| What you see | Next action |
| --- | --- |
| A native approval prompt | Review it in the original Claude conversation; changing chill Auto mode will not answer it |
| Claude closed | Resume the same native session; the opt-in resume watcher checks saved replies |
| Waiting has expired or receipt is unconfirmed | Ask that same conversation to inspect `connection inbox`; do not resend |
| A request or delivery is uncertain | Inspect its existing request/receipt; do not create a replacement Root or resend the message |
| A manual hold | Preserve it until the user resumes that work |

The [connection status](claude-status.md) reports observed checks and expiry,
not guaranteed availability. Follow [main-hook recovery](claude-actions.md)
using the prepared CLI prefix and separate main Bash calls.

Current qualification covers an actual eleven-minute wait under a twelve-hour
configuration, plus first-use interactive permissions. It does not establish
overnight uptime or permissions for every future project operation.
