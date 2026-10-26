---
keyPoints: >-
  A Goal records an outcome and its criteria; children inherit the root's chat.
  Done requires every descendant to be Done, while progress counts completed leaves.
  Each Goal has its own Autonomy, 1 Normal to 3 Drive, set with the slider in its comment box.
---

# Goals describe outcomes

A Goal has a title, agreed scope and success criteria. Split it when there are
separate outcomes to review. Keep refinements of the same outcome in its
[Deliverable](deliverables-and-conversation.md).

```sh
chill goal create --title "Improve onboarding" --scope "First-run setup" --criteria "A new user can finish setup"
chill goal create --parent 1 --title "Explain setup failures"
```

Use the IDs returned by the commands. A root may be assigned to one chat; its
children share that assignment. See [feedback delivery](../agent/feedback-and-controls.md)
for the effect of assigning or changing that chat.

## Record completion deliberately

The stored work states are `idle` (Open), `waiting` and `done`. Waiting requires
a reason. Update metadata through `goal update --input-file`, using its help for
the accepted fields. For example, a file containing `{"state":"done"}` records
completion after the outcome has been checked.

The store rejects Done while any descendant is unfinished. Completing children
does not complete their parent: check the parent's own criteria, record the
result, then mark it Done. A new child, a move under a Done ancestor, or reopening
a Done child reopens Done ancestors.

Progress counts leaf Goals equally. Two Done leaves out of three contribute 67%,
regardless of how deeply they are nested. An unfinished Goal is capped at 99%:
all leaves being complete still leaves the parent's own completion to confirm.
Publishing a Deliverable, posting a Comment or acknowledging feedback adds no progress.

Running and Paused are observed activity, not additional stored work states.
A Done Goal can temporarily display Running without losing its completion.
See [execution state](../agent/execution-state.md).

Implementation: [Goal store](../../lib/goal-store.mjs),
[progress calculation](../../public/goal-progress.js).

## Autonomy: how far the agent goes on its own

Each Goal keeps one Autonomy level, 1 to 3, set with the one-line slider left of
"Add file" in the Goal's comment box: the level's icon, then the stops, with the
current one named. Hovering the icon or a stop shows the level and what it asks.
Moving it saves at once, apart from any comment.
A new Goal copies its parent's level when it is created; a Root starts at 1.
Nothing is inherited afterwards: each slider changes only its own Goal.

| Level | End of turn | Tool prompts (Claude) |
| --- | --- | --- |
| 1 Normal | nothing | asked as usual |
| 2 Continue | keep working on what was agreed for the Goal | allowed |
| 3 Drive | advance the whole Root tree where no user judgment is needed; decisions go to Letters | allowed |

Autonomy adds nothing to the feedback text.
Hooks read the level afresh, so a running agent meets a change at its next hook.
A conversation's Goals are the unfinished Goals, in the Roots it owns, that its
current work was handed, that it last worked in, or that it selected with
`goal work`; when none is unfinished, each owned Root's focus (the Goal with its
latest user comment, or the Root) stands in.

- **End of turn.** One message per conversation, from the highest level among its
  Goals. It lists the Goals at 2 or higher with what each level asks, so it stands
  on its own. A Goal at 3 brings its Root tree in, without the Goals other live
  conversations work on, which it names as taken. A Claude conversation gets it at
  its Stop hook; the Web server checks a Codex chat every 30 seconds. One check per
  revision: a user comment, a Goal or Deliverable change, or a level change.
- **Tool prompts.** Allowed when any of the conversation's Goals is at 3, or when
  the lowest among them is at least 2; otherwise, and with no Goals, the prompt
  asks as usual. Questions for the user (AskUserQuestion) are never answered, and
  a paused conversation is not answered. Codex prompts cannot be answered by hooks.

`POST /api/goals/<id>/autonomy` with `{"level":2}` (same-origin JSON) is the
slider's API. Workspaces from before Autonomy had an AutoContinue switch per
Root: on first use, every Goal under a Root that had it On without a level of
its own starts at Continue, and the switch is removed from the Root's journal.
Approve all is not carried over.

Autonomy first had four levels, with 2 Thorough between Normal and Continue.
Once per workspace, stored levels move to the three-level scale: 2 becomes 1, 3
becomes 2 and 4 becomes 3. `workspace/autonomy-scale.json` records the Goals to
move before any is written and reads `{"levels":3}` when done, so an interrupted
run repeats the same writes. The AutoContinue move above runs first.

Implementation: [levels](../../public/autonomy.js), [rules](../../lib/autonomy.mjs),
[end-of-turn message](../../lib/continuation-monitor.mjs).

## Hide an unused root

Use `chill goal update --id <root> --input-file archive.json` with
`{"archived":true}` to remove an unused root and its descendants from normal
lists and continuation discovery. This preserves their IDs, Deliverables and
Conversation; it does not mark unfinished work Done. Restore the same ID with
`{"archived":false}`. Archive only whole roots, so hiding a SubGoal cannot make
an incomplete parent appear finished. Archiving is not a command to interrupt
an already running agent or delete its queued messages.
