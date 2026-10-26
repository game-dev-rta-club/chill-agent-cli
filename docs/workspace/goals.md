---
keyPoints: >-
  A Goal records an outcome and its criteria; children inherit the root's chat.
  Done requires every descendant to be Done, while progress counts completed leaves.
  Autonomy is set per agent (per Root): Normal, Auto Continue or Ultra Continue, from any Goal's comment box.
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

Autonomy is set per agent (per Root): the conversation that owns a Root has one
level for it, **Normal**, **Auto Continue** or **Ultra Continue**. Every Goal's
comment box shows that level and sets it; all Goals of a tree show the same
value. It is stored as 1 to 3 but always shown by name. Changing it saves at
once, apart from any comment.

| Level | End of turn | Tool prompts (Claude) |
| --- | --- | --- |
| Normal | nothing | asked as usual |
| Auto Continue | keep carrying out what the agent and the user agreed, in any Goal under the Root; questions go to Letters | allowed |
| Ultra Continue | the Root is delegated: plan toward its success criteria and move its whole tree forward; only the user's decisions go to Letters | allowed |

The level is kept as `autonomy` in the Root's continuation journal record
(`workspace/continuation/<rootId>.json`), which names the agent it was written
for. The same conversation, or a continued one that took the Root over (listed in
the Root's `previousConnections`), keeps the level. Any other conversation taking
the Root gets a fresh record, so it starts at Normal. A level set on a Root no
conversation works on yet is kept without an owner, and the first agent on the
Root takes it over. Goals have no level of their own.

Autonomy adds nothing to the feedback text.
Hooks read the level afresh, so a running agent meets a change at its next hook.

- **End of turn.** One message per conversation, from its Root at the highest
  level. It lists each unfinished Root it owns above Normal, by level name, with
  what that level asks, so it stands on its own. A Root at Ultra Continue brings
  its unfinished Goals in, without the Goals other live conversations work on,
  which it names as taken. A Claude conversation gets it at its Stop hook; the
  Web server checks a Codex chat every 30 seconds. One check per revision: a user
  comment, a Goal or Deliverable change, or a level change.
- **Tool prompts.** Allowed when the conversation owns at least one Root and every
  Root it owns is at Auto Continue or Ultra Continue; owning none, the prompt asks
  as usual. Questions for the user (AskUserQuestion) are never answered, and a
  paused conversation is not answered. Codex prompts cannot be answered by hooks.

`POST /api/goals/<id>/autonomy` with `{"level":2}` (same-origin JSON) sets the
level of the Goal's Root agent and answers `{"goalId","rootId","autonomy"}`.
`GET /api/goals?view=web` gives every Goal the `autonomy` of its Root's agent.

Earlier workspaces move on first use, in this order:

1. AutoContinue was an On/Off switch per Root. Every Goal under a Root that had
   it On without a level of its own gets the level now named Auto Continue, and
   the switch is removed from the Root's journal. Approve all is not carried over.
2. Autonomy first had four levels, with Thorough between Normal and Continue.
   Once per workspace, stored levels move to the three-level scale: 2 becomes 1,
   3 becomes 2 and 4 becomes 3. `workspace/autonomy-scale.json` records the Goals
   to move before any is written and reads `{"levels":3}` when done, so an
   interrupted run repeats the same writes.
3. Autonomy was then kept per Goal. Each Root Goal's level, when above Normal,
   is written into its journal for the Root's current agent (or with no owner),
   and the `autonomy` field is removed from every Goal. Once the field is gone
   nothing is left to move, so the step is idempotent.

Implementation: [levels](../../public/autonomy.js), [per-Root storage](../../lib/root-autonomy.mjs),
[journal owner](../../lib/continuation-owner.mjs), [rules](../../lib/autonomy.mjs),
[end-of-turn message](../../lib/continuation-monitor.mjs).

## Hide an unused root

Use `chill goal update --id <root> --input-file archive.json` with
`{"archived":true}` to remove an unused root and its descendants from normal
lists and continuation discovery. This preserves their IDs, Deliverables and
Conversation; it does not mark unfinished work Done. Restore the same ID with
`{"archived":false}`. Archive only whole roots, so hiding a SubGoal cannot make
an incomplete parent appear finished. Archiving is not a command to interrupt
an already running agent or delete its queued messages.
