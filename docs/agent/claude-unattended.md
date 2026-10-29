---
keyPoints: >-
  Before leaving Claude, confirm a watcher is running and try one Web reply
  in the same conversation, then review native permissions for the actual work.
  The Root agent's Autonomy decides how far it goes on its own; from Auto Continue
  it also answers tool prompts chill can answer. The Web does not
  start a closed Claude process.
---

# Leave a Claude conversation working

Use this after [project setup](claude-setup.md), in the same conversation that
owns the Goal. Web replies reach it through the [watcher hook](claude-wait.md),
which runs as long as that Claude process does; in Claude Desktop a
`agent wait` task also keeps Desktop from pausing the conversation. Keep
Claude and the computer running while you are away.

## Understand what remains running

The Web saves messages; the Claude process receives and answers them. The
integration does not start a closed Claude automatically. Use one live process
for one conversation: opening another copy with `--resume` is not an attachment
to the existing process. To reopen after exit, resume the same project and
session. The watcher hook starts again with it; in Claude Desktop its
SessionStart context asks the agent to start the `agent wait` task again.

## Decide what to delegate

There are two decisions:

| Setting | What it controls |
| --- | --- |
| The Root agent's [Autonomy](../workspace/goals.md#autonomy-how-far-the-agent-goes-on-its-own) | How far the agent goes on its own: keep carrying out the agreed work (Auto Continue) or take the whole Root tree toward its criteria (Ultra Continue). At either, the PermissionRequest hook answers prompts with Allow |
| Claude tool permissions | Which reads, commands and edits can execute without another approval at Autonomy Normal |

Review the operations the work requires in Claude's permission settings. Saved
command-specific allowances can avoid repeated prompts. A one-time approval does
not authorize the next reply. Native ask or deny rules can override an
allowance. Claude's own permission mode named `auto` is a separate native policy;
raising a Root's Autonomy does not select it.
See [Claude's permission guide](https://code.claude.com/docs/en/permissions).

Every chill command starts with the entry printed by setup, so a single command
prefix rule for that entry can cover them; the permission guide describes the
rule syntax. A rule allowing every `node`
or Bash invocation delegates much more than chill operations. The installer
leaves these choices with the user.

## Questions come to the Web

A conversation that owns a Goal never waits in Claude's own app for you. Its
hooks refuse each step that would, and tell the agent what to do instead:

| Step Claude would take | What the agent does instead |
| --- | --- |
| Ask a question (AskUserQuestion) | Sends it as a Letter (a reply with `--ask`) and continues work that does not depend on the answer |
| End a response with a question or choice buttons in the Desktop next-step box (wrap_up) | Sends it as a Letter; a closing recap without a question still shows |
| Suggest a separate task (the Desktop task chip) | Does the work itself, or creates a Split Goal |
| Ask you to approve a plan (ExitPlanMode) | Sends the plan as a Letter; after you reply on the Web, it leaves plan mode without another prompt |

Native permission prompts are not among these; review them as described above.

## Try the work you will actually leave running

Check that the Agent menu shows **Receives Web replies**. Then send one small
Web request, for example: “Read the current Deliverable and report one next action; do
not change files.” Check that Claude wakes and replies on
the Web. If Claude asks for a permission, review the actual operation there. Do
not send the Web request again to clear a permission prompt.

This exercises the reply command and reading, not permission for future edits,
tests or deployment. Review a representative action from the agreed work before
leaving. If an operation should remain your decision, leave that approval in
place: the affected action may wait while independent work continues.

## Find the reason if progress stops

| What you see | Next action |
| --- | --- |
| A native approval prompt | Review it in the original Claude conversation, or raise the Autonomy of the conversation's Roots to Auto Continue; a prompt Claude Code never lets a hook approve still asks |
| No watcher is running | Ask that same conversation to check `goal inbox`; its next Stop starts the watcher again, and in Claude Desktop the result names the task to start |
| Claude closed | Resume the same native session |
| A delivery is uncertain | Read `goal inbox` in the same conversation; do not create a replacement Root or resend the message |
| A manual hold | Preserve it until the user resumes that work |

The [connection status](claude-status.md) reports recorded evidence, not
guaranteed availability. Recover with the [connection actions](claude-actions.md)
using the prepared CLI prefix.
