---
keyPoints: >-
  A Goal records an outcome and its criteria; children inherit the root's chat.
  Done requires every descendant to be Done, while progress counts completed leaves.
---

# Goals describe outcomes

A Goal has a title, agreed scope and success criteria. Split it when there are
separate outcomes to review. Keep refinements of the same outcome in its
[Brief](briefs-and-conversation.md).

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
Publishing a Brief, posting a Comment or acknowledging feedback adds no progress.

Running and Paused are observed activity, not additional stored work states.
A Done Goal can temporarily display Running without losing its completion.
See [execution state](../agent/execution-state.md).

Implementation: [Goal store](../../lib/goal-store.mjs),
[progress calculation](../../public/goal-progress.js).

## Hide an unused root

Use `chill goal update --id <root> --input-file archive.json` with
`{"archived":true}` to remove an unused root and its descendants from normal
lists and continuation discovery. This preserves their IDs, Briefs and
Conversation; it does not mark unfinished work Done. Restore the same ID with
`{"archived":false}`. Archive only whole roots, so hiding a SubGoal cannot make
an incomplete parent appear finished. Archiving is not a command to interrupt
an already running agent or delete its queued messages.
