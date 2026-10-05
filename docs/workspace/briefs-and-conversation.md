---
keyPoints: >-
  Edit the existing Brief source and publish a snapshot; comments preserve discussion.
  Letters track explicit questions, and answering one does not complete or unblock work.
---

# Keep the explanation and discussion together

The Brief is the current explanation of a Goal. Conversation keeps the
discussion about it, including feedback tied to an older Brief version. Updating
the explanation does not erase that history.

## Publish the Brief

```sh
chill goal brief path --id 1
# Edit the returned file.
chill goal brief update --id 1
```

Editing the file alone does not change Web. Publishing saves an immutable version
when the body or format differs; identical content is a no-op. An empty source
clears the Brief. The command does not create a Conversation message or complete
the Goal.

Markdown supports lists, tables, code and Mermaid diagrams. For a custom layout,
request `--format html` from `brief path` and publish with the same format. HTML
renders in an isolated frame; scripts, forms and remote assets do not run.
Switching format keeps previous versions and both editable source files.

Upload images with `goal image` and use the returned `/api/images/<id>` reference.
Text annotations retain their source version; image notes retain their attachment
and location. Read the relevant version when responding to older feedback.

## Comments and Letters

Use `goal comment --id 1 --text-file result.txt` for progress or results. Use
`goal letter --id 1 --title "Choose a direction" --text-file question.txt` when
the user needs to answer. Files preserve multiline text without shell escaping.

A direct user answer changes a Letter from open to answered; an unrelated
comment leaves it open. If a question no longer needs an answer, explicitly use
`goal close-letter --id 1 --event <LETTER_ID>`. The question and discussion remain
saved. Answered or received Letters do not appear in the unanswered list.

A Letter answer is not automatically approval, an end to Waiting, or completion.
Read the answer and decide what it changes within the agreed scope. The
[layered reader](reading-goals.md) keeps the original question with its answers.

Implementation: [Brief rendering](../../lib/brief.mjs),
[Letter state](../../public/letter-state.js), [event storage](../../lib/goal-store.mjs).
