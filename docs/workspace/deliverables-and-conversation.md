---
keyPoints: >-
  The Deliverable holds only a Goal's final output; progress and questions go to Conversation.
  Edit its source and publish a snapshot; comments preserve discussion.
  Static HTML works in Messages; HTML Deliverable images and SVG diagrams support notes.
  A reply that asks the user to decide is marked --ask and becomes a Letter; the user's next comment on the Goal closes it.
  Neither answers nor viewing complete or unblock work.
---

# Keep the final output and the discussion apart

The Deliverable holds only the final output of a Goal: the document, design or
result it hands over, which may be a draft while the work goes on. A plan or
proposal the user decides on may be a SubGoal's Deliverable. Progress and
questions belong in Conversation, which also keeps feedback tied to
an older Deliverable version. Updating the Deliverable does not erase that history.
The editable source is `deliverable.html` or `deliverable.md`; files from before the
rename (`brief.*`) are moved to the new name the first time the workspace opens.

## Publish the Deliverable

```sh
chill goal deliverable path --id 1
# Edit the returned file.
chill goal deliverable update --id 1
```

Editing the file alone does not change Web. Publishing saves an immutable version
when the body or format differs. Identical content is not published and the
command fails, so an edit that never reached the file is noticed. An empty source
clears the Deliverable. The command does not create a Conversation message or complete
the Goal.

A new Deliverable starts as HTML (`deliverable.html`): a standalone,
visual-first page with its own `<style>` and inline SVG diagrams, rendered in an
isolated frame where scripts, forms and remote assets do not run. Existing
Markdown Deliverables still work with `--format markdown`. Switching format keeps
previous versions and both editable source files. When the published content is
Markdown, or HTML without any table, SVG, image or grid/flex layout, `update`
still publishes and adds a one-line `hint` toward a visual-first page.

Upload images with `goal image` and use the returned `/api/images/<id>` reference.
Other files, such as a video, upload the same way; they keep their file name, so
a download from Web has the same extension.
Text annotations retain their source version; image notes retain their attachment
and location. Read the relevant version when responding to older feedback.
HTML images have an annotation button. Inline SVG diagrams use the same area
selector and retain their Deliverable version and SVG index, so changing a diagram
does not move an old note onto its replacement. The original diagram can be
opened at `/api/goals/<id>/deliverables/<version>/svg/<index>` (indices start at zero).
Small SVG icons below 64 pixels in either dimension keep their display without
an overlaid annotation control.

## Comments and Letters

The agent posts every message with one command: `goal comment --id 1 --text-file reply.txt`,
or `connection reply --goal 1 --text-file reply.txt` in a Claude conversation. Files
preserve multiline text without shell escaping. If the message asks the user to
decide or approve something, the agent adds `--ask '<what to decide>'`; the
message is then a Letter titled with that line, shown and counted in the Letters
menu and notified as a Letter. It still answers the comments the agent was
handed, and works when none arrived. Without `--ask` the message is an ordinary
Comment. Do not create a Letter just to ask the user to acknowledge a report.
Pending replies block only the actions that actually depend on them; continue
independent authorized work. Letters saved by the earlier `goal letter` command
still show as they were, and its historical no-reply records stay out of pending
counts, so updating does not turn old results into new unanswered questions.

Message bodies already accept static HTML such as paragraphs, lists, tables,
links and disclosures, alongside Markdown. Both authors use the same sanitizer;
scripts, forms, custom styles and remote images are removed. Use a standalone
HTML Deliverable when the explanation needs its own layout or styling.

`#N` in a message or a Markdown Deliverable always names Goal N, as on GitHub. It
links to that Goal unless it is inside code or a link, glued to a word or path
(`abc#1`, `/#1`), or no such Goal exists. A Goal named from another Goal's
Conversation shows "Mentioned in #M" in its own Conversation, once per Goal, at
the first Comment that named it. chill never writes Comment or Letter numbers with
`#`; it writes `comment 1006` or `Letter 868`.

Users answer a Letter with an ordinary Comment on its Goal, or an annotation on
the Letter; there is no separate Answer button. Any user comment on the Goal
closes the Goal's open Letters and records that comment as the answer, even when
it is about something else: once the user speaks it is the agent's turn, and it
asks again with `--ask` if the question still stands. If a question no longer
needs an answer before the user replies, the agent withdraws it with
`goal close-letter --id 1 --event <LETTER_ID>`. The question and discussion remain
saved. Answered or withdrawn Letters do not appear in the unanswered list.

An agent Comment or Letter posted by mistake, for example to the wrong Goal or
project, can be deleted with `goal delete-comment --id <goal> --event <id>`. Its
text, title and images leave Conversation for every reader, including open Webs;
a deleted Letter is no longer open. User comments cannot be deleted.

A Letter answer is not automatically approval, an end to Waiting, or completion.
Read the answer and decide what it changes within the agreed scope. The
[layered reader](reading-goals.md) keeps the original question with its answers.

Implementation: [Deliverable rendering](../../lib/brief.mjs),
[Letter state](../../public/letter-state.js), [event storage](../../lib/goal-store.mjs).
