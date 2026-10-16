---
keyPoints: >-
  The Deliverable holds only a Goal's final output; plans and progress go to Conversation.
  Edit its source and publish a snapshot; comments preserve discussion.
  Static HTML works in Messages; HTML Deliverable images and SVG diagrams support notes.
  Letters distinguish questions from reply-free outcomes; neither answers nor viewing complete or unblock work.
---

# Keep the final output and the discussion apart

The Deliverable holds only the final output of a Goal: the document, design or
result it hands over, which may be a draft while the work goes on. Plans,
progress and questions belong in Conversation, which also keeps feedback tied to
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
when the body or format differs; identical content is a no-op. An empty source
clears the Deliverable. The command does not create a Conversation message or complete
the Goal.

A new Deliverable starts as HTML (`deliverable.html`): a standalone document
with inline CSS and SVG, rendered in an isolated frame where scripts, forms and
remote assets do not run. Markdown remains available with `--format markdown`
and supports lists, tables, code and Mermaid diagrams. Switching format keeps
previous versions and both editable source files. How agents write a
Deliverable is set by the agent guide, not by this CLI.

Upload images with `goal image` and use the returned `/api/images/<id>` reference.
Text annotations retain their source version; image notes retain their attachment
and location. Read the relevant version when responding to older feedback.
HTML images have an annotation button. Inline SVG diagrams use the same area
selector and retain their Deliverable version and SVG index, so changing a diagram
does not move an old note onto its replacement. The original diagram can be
opened at `/api/goals/<id>/deliverables/<version>/svg/<index>` (indices start at zero).
Small SVG icons below 64 pixels in either dimension keep their display without
an overlaid annotation control.

## Comments and Letters

Use `goal comment --id 1 --text-file result.txt` for results, completion reports or routine progress. Use
`goal letter --id 1 --title "Choose a direction" --text-file question.txt` only when a user reply, choice or permission is needed. Files preserve multiline text without shell escaping.

Users answer a Letter with an ordinary Comment; there is no separate Answer
button. Do not create a Letter just
to ask the user to acknowledge a report. Pending replies block only the actions
that actually depend on them; continue independent authorized work. The old
`--no-reply` option is compatibility-only; historical records stay out of pending
counts, so updating does not turn old results into new unanswered questions.

Message bodies already accept static HTML such as paragraphs, lists, tables,
links and disclosures, alongside Markdown. Both authors use the same sanitizer;
scripts, forms, custom styles and remote images are removed. Use a standalone
HTML Deliverable when the explanation needs its own layout or styling.

When a delivered Comment answers a Letter, the agent records it before other
work with `goal close-letter --id 1 --event <LETTER_ID> --answer <COMMENT_ID>`,
and the Letter shows as Replied. Each delivery lists the open Letters with that
command as a reminder. An unrelated comment leaves the Letter open. If a
question no longer needs an answer, use `close-letter` without `--answer`. The question and discussion remain
saved. Answered or received Letters do not appear in the unanswered list.

An agent Comment or Letter posted by mistake, for example to the wrong Goal or
project, can be deleted with `goal delete-comment --id <goal> --event <id>`. Its
text, title and images leave Conversation for every reader, including open Webs;
a deleted Letter is no longer open. User comments cannot be deleted.

A Letter answer is not automatically approval, an end to Waiting, or completion.
Read the answer and decide what it changes within the agreed scope. The
[layered reader](reading-goals.md) keeps the original question with its answers.

Implementation: [Deliverable rendering](../../lib/brief.mjs),
[Letter state](../../public/letter-state.js), [event storage](../../lib/goal-store.mjs).
