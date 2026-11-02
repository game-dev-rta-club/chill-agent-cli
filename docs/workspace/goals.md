---
keyPoints: >-
  A Goal records an outcome and its criteria; children inherit the root's chat.
  Goals moved into another Root, a whole Root too, follow that Root's agent and settings.
  Done requires every descendant to be Done, while progress counts completed leaves.
  Autonomy is set per agent (per Root): Normal, Auto Continue or Never Stop, from any Goal's comment box.
---

# Goals describe outcomes

A Goal has a title, agreed scope and success criteria. Split it when there are
separate outcomes to review. Keep refinements of the same outcome in its
[Canvas](deliverables-and-conversation.md).

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

## Move Goals between Roots

`goal update` with a `parentId` moves a Goal, with its Split Goals, under any
Goal, also one in another Root and also when the moved Goal is a Root itself.
The moved Goals then follow the destination Root: its agent receives and answers
their comments, and its Autonomy, notifications and look apply. A comment the
earlier agent was never handed goes to the new one once; one it was handed and
did not answer is listed to the new one as earlier. The earlier agent can no
longer reply there.

A Root that moves drops what it kept as a Root: its conversation or chat, its
Autonomy, notification choice and look. If it becomes a Root again
(`{"parentId":null}`), it stays with the agent it moved to and starts from the
defaults. Restore an archived Root before moving it. IDs, Conversation and
Canvases stay. The Web has no move control; ask the agent.

Progress counts leaf Goals equally. Two Done leaves out of three contribute 67%,
regardless of how deeply they are nested. An unfinished Goal is capped at 99%:
all leaves being complete still leaves the parent's own completion to confirm.
Publishing a Canvas, posting a Comment or acknowledging feedback adds no progress.

Running and Paused are observed activity, not additional stored work states.
A Done Goal can temporarily display Running without losing its completion.
See [execution state](../agent/execution-state.md).

Implementation: [Goal store](../../lib/goal-store.mjs),
[progress calculation](../../public/goal-progress.js).

## Autonomy: how far the agent goes on its own

Autonomy is set per agent (per Root): the conversation that owns a Root has one
level for it, **Normal**, **Auto Continue** or **Never Stop**. Every Goal's
comment box shows that level and sets it; all Goals of a tree show the same
value. It is stored as 1 to 3 but always shown by name, never by number.

In the comment box it is a button at the left of the Add file / Comment row,
showing the level's icon and name; on a narrow row the comment buttons wrap below
it. The button opens a small Autonomy panel, built like the Color theme panel:
each level as a row with its icon, name and one-line description, and a check on
the current one. Choosing a row saves at once, apart from any comment, and closes
the panel; Escape or a click outside closes it without a change. If the save fails the panel stays open and says so.

| Level | End of turn | Tool prompts (Claude) |
| --- | --- | --- |
| Normal | nothing | asked as usual |
| Auto Continue | keep carrying out what the agent and the user agreed, in any Goal under the Root, and keep each Goal showing where its work stands; anything not agreed is suggested in its Goal; questions go to Letters | allowed |
| Never Stop | the Root is delegated: plan toward its success criteria, dig past a first pass and move its whole tree forward, reading whatever helps beyond the workspace except secrets; only the user's decisions go to Letters. In Claude, a turn is held until a check is scheduled | allowed |

The level is kept as `autonomy` in the Root's continuation journal record
(`workspace/continuation/<rootId>.json`), which names the agent it was written
for. The checks themselves are the agent's, one record for all its Roots
(`workspace/turn-checks/`). The same conversation keeps the level. One that
takes the Root from another conversation with `goal adopt` starts at Normal, so
the earlier conversation's tool approval never comes along; the user sets the
level again on the Web. A level set on a Root no conversation works on yet is
kept without an owner, and the conversation that adopts it takes it over. Either
way the record then names the new owner, so it passes the level on no further.
A record written for an owner the Root never had reads as Normal. Goals have no
level of their own.

Autonomy adds nothing to the feedback text.
Hooks read the level afresh, so a running agent meets a change at its next hook.

- **End of turn.** One message per conversation, from its Root at the highest
  level. It lists each unfinished Root it owns above Normal, by level name, with
  what that level asks, so it stands on its own. Each Root brings its
  unfinished Goals in, without the Goals other live conversations work on,
  which it names as taken. A Claude conversation gets it at its Stop hook; the
  Web server checks a Codex chat every 30 seconds. One check per revision, for the
  conversation however many Roots it owns: a user comment, a Goal or Canvas
  change, or a level change in any Root above Normal that is not Done; a Normal or Done Root starts no check.
- **Never Stop's hold (Claude only).** Once that message has been sent, while
  the conversation owns an unfinished Root at Never Stop and has no scheduled
  check (`agent wake`), every Stop is held, not only once per revision, with a
  request to bring its Goals up to date and schedule a check. A scheduled check,
  a lower level, a pause or a Done Root lets the turn end; if scheduling fails,
  the agent says so on the Root and stays held until one of the others happens.
  Codex has no scheduled checks, so this does not apply there.
- **A level change.** When a Root the agent owns has a level other than the one
  last stated to it (by an end-of-turn message or an earlier notice), chill
  tells the agent once what the new level asks; a lowered level applies to work
  already under way too, so an end-of-turn message never counts as telling it a
  lowered level. It does so the next time it hands the conversation anything: a
  tool hook, a scheduled check or comment waking an idle Claude conversation, a
  message to an idle Codex chat. chill does not remove checks, since only the
  agent knows which still serve its work; a Claude notice lists them with
  `agent wake --cancel <time|all>`, and every due check is done only if still
  needed. A Root chill first finds is recorded without a notice. The levels
  stated are kept in `workspace/levels-told/`.
- **Tool prompts.** A prompt names no Goal, so the Root the user last commented
  in (on it or any Goal under it) decides among the Roots the conversation owns;
  with no comment in any of them, the newest Root. At Auto Continue or Never
  Stop the prompt is allowed; owning none, it asks as usual. Questions for the user (AskUserQuestion) are never answered, and a
  paused conversation is not answered. Codex prompts cannot be answered by hooks.

`POST /api/goals/<id>/autonomy` with `{"level":2}` (same-origin JSON) sets the
level of the Goal's Root agent and answers `{"goalId","rootId","autonomy"}`.
`GET /api/goals?view=web` gives every Goal the `autonomy` of its Root's agent.

Earlier workspaces move on first use, in this order, once: `workspace/migrations.json`
records each move by name when it has finished, so a migrated workspace never
looks for these old shapes again, and one an older runtime writes later is not
read as a level.

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
[end-of-turn message](../../lib/continuation-monitor.mjs). The comment box's
dropdown is checked in a browser by `test/autonomy-web.mjs` (run by hand with
Playwright, like the other `test/*-web.mjs` scripts).

## Hide an unused root

Use `chill goal update --id <root> --input-file archive.json` with
`{"archived":true}` to remove an unused root and its descendants from normal
lists and continuation discovery. This preserves their IDs, Canvases and
Conversation; it does not mark unfinished work Done. Restore the same ID with
`{"archived":false}`. Archive only whole roots, so hiding a SubGoal cannot make
an incomplete parent appear finished. Archiving is not a command to interrupt
an already running agent or delete its queued messages.
