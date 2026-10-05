---
keyPoints: >-
  Review gives one line per Goal with state filters and ancestor context. Show opens
  one Brief and recent discussion, with explicit commands for older or longer content.
---

# Read a workspace in layers

Start with an index rather than every Brief and conversation in the project.
Use the stable command prefix from setup in place of `chill`.

```sh
chill goal review --id 1
chill goal review --id 1 --state unfinished
```

Each Goal occupies one line: indentation, ID, Web state, progress percentage,
and relevant facts such as its own unanswered Letter count. The index includes
all descendant levels. Filtering retains ancestors as context rows so indentation
never implies a different parent. Context rows are not counted in the page.

`--state` accepts `open`, `running`, `paused`, `waiting`, `done`, `unfinished`, or
`all`. Unfinished includes everything except Done, so starting work does not make
a Goal disappear from the query. `--letters` selects Goals with their own
unanswered Letters and can be combined with a state filter. No Open Goals does
not imply completion: the output shows the other state counts and useful queries.

The default page contains 50 matching Goals. Follow the printed `--after` command
for the next page. Counts distinguish the entire subtree, matching Goals and
this page. Reads reflect current state; if the workspace changes while paging,
restart the query for a new overview. The cursor remains valid if that Goal no
longer matches the filter, but not if it has moved outside the queried subtree.

## Open one Goal

```sh
chill goal show --id 6 --format text
```

Text includes its scope, success criteria, root agreement, latest Brief, own
unanswered Letters and the latest five conversation messages. It links to the
subtree index instead of repeating all branches. Older conversation pages include
an exact `--before` command. Answers keep their original Letter question even
when it lies outside the selected page.

Long Briefs are shown in 6000-character chunks. The continuation command pins
the Brief version so a subsequent edit cannot mix versions in the same reading.
`--section brief`, `conversation`, or `letters` reads only that section.

An explicit `--since` returns **all newer feedback**, unless `--limit` is also
specified. This preserves later corrections in delivery messages. `--full` gives
unabridged text and branch summaries. JSON remains complete by default; explicit
conversation filters apply to either format. `--version` selects only a Brief
version, never an older Goal state or conversation.

Reading refreshes execution observations but does not start model turns, close
Letters, complete Goals, or consume queued feedback. Use installed command help
for the complete option contract.


Implementation: [index](../../lib/goal-review.mjs),
[Goal text reader](../../lib/goal-page-text.mjs).
