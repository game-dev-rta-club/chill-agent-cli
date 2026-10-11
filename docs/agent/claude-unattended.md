---
keyPoints: >-
  Before leaving Claude, confirm a reply waiter is running and try one Web reply
  in the same conversation, then review native permissions for the actual work.
  chill Auto mode delegates decisions; it does not approve tools. The Web does not
  start a closed Claude process.
---

# Leave a Claude conversation working

Use this after [project setup](claude-setup.md), in the same conversation that
owns the Goal. Web replies reach it through the [reply waiter](claude-wait.md),
which runs as long as that Claude process does. Keep Claude and the computer
running while you are away.

## Understand what remains running

The Web saves messages; the Claude process receives and answers them. The
integration does not start a closed Claude automatically. Use one live process
for one conversation: opening another copy with `--resume` is not an attachment
to the existing process. To reopen after exit, resume the same project and
session; its SessionStart context asks the agent to start the waiter again.

## Decide what to delegate

There are two independent decisions:

| Setting | What it controls |
| --- | --- |
| chill Auto mode | Whether the agent chooses and carries out the next useful action toward the agreed Goal |
| Claude tool permissions | Which reads, commands and edits can execute without another approval |

Review the operations the work requires in Claude's permission settings. Saved
command-specific allowances can avoid repeated prompts. A one-time approval does
not authorize the next receipt. Native ask or deny rules can override an
allowance. Claude's own permission mode named `auto` is a separate native policy;
selecting chill Auto mode does not select it.
See [Claude's permission guide](https://code.claude.com/docs/en/permissions).

Use the exact stable command prefix printed by chill setup when reviewing a
command. A rule allowing every `node` or Bash invocation delegates much more
than chill operations. The installer leaves these choices with the user.

## Try the work you will actually leave running

Check that the Agent menu shows **Waiting for Web replies**. Then send one small
Web request, for example: “Read the current Brief and report one next action; do
not change files.” Check that Claude wakes, completes its receipt and replies on
the Web. If Claude asks for a permission, review the actual operation there. Do
not send the Web request again to clear a permission prompt.

This exercises receipt commands and reading, not permission for future edits,
tests or deployment. Review a representative action from the agreed work before
leaving. If an operation should remain your decision, leave that approval in
place: the affected action may wait while independent work continues.

## Find the reason if progress stops

| What you see | Next action |
| --- | --- |
| A native approval prompt | Review it in the original Claude conversation; changing chill Auto mode will not answer it |
| No reply waiter is running | Ask that same conversation to check `connection inbox`; its result names the waiter to start |
| Claude closed | Resume the same native session |
| A request or delivery is uncertain | Inspect its existing request/receipt; do not create a replacement Root or resend the message |
| A manual hold | Preserve it until the user resumes that work |

The [connection status](claude-status.md) reports recorded evidence, not
guaranteed availability. Follow [main-hook recovery](claude-actions.md) using
the prepared CLI prefix and separate main Bash calls.
