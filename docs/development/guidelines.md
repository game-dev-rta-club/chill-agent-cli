---
keyPoints: >-
  Pair actionable development guidelines with small task-triggered read-this skills.
  Keep rules in canonical documents, skill sources in this repository, and update
  links and discovery entries together; file validity does not prove automatic activation.
---

# Make development guidance discoverable

When a development convention changes, update its document and the task entry
that helps an agent find it in the same change. A new agent should know which
page to read from the requested action, without receiving the whole handbook.

## Keep one home for the rule

Put maintained development guidance in `docs/development/`; use `RELEASING.md`
for release procedure and `CONTRIBUTING.md` for contributor entry. State the
intended outcome, concrete actions, relevant boundaries and evidence of success.
Separate implemented behavior from proposals and repository settings not yet
activated. Keep task history and temporary failures in the Goal or PR.

Before adding a page, inspect the documentation map and related pages. Update an
existing explanation when it already owns the decision. Split pages when readers
have different tasks, not for each command or flag. Add concise English
`keyPoints` so a documentation index can preview what changes a reader's decision.

## Add the read-this entry with it

Repository development skills live in `.agents/skills/<name>/SKILL.md`. This is
the checked-in source, not a generated plugin cache. Each skill has a unique
repository-prefixed `name` and a `description` naming the user actions that should
select it. Say what does not belong there when adjacent skills could overlap.

Keep the body short: read the canonical document before working, then act using
its guidance. Do not paste the document's rules into the skill. Relative Markdown
links resolve from the skill directory; in this layout `../../../docs/` reaches
the repository documentation. Avoid machine-specific absolute paths.

For example, a request to change branch policy selects the guideline-authoring
entry; committing and integrating that change also uses the development entry.
A request to fix a UI bug uses the development entry without loading guideline
authoring. Publishing a version uses the release entry, not an unrelated feature
workflow. Skill selection does not itself authorize publication.

## Maintain the entry points together

Link each skill from `AGENTS.md` and the relevant document so it is reachable
when automatic skill discovery is unavailable. Keep AGENTS as a short task map,
not a duplicate handbook. Update the docs index, inbound links and descriptions
when a page moves or its responsibility changes. Remove obsolete entries when
their task disappears. Reuse guidance already read and unchanged in the task.

Use project skills for developing this repository; the product's distributed
skills teach end users how to use chill-agent and are a separate surface. Do not
ship repository development rules in the end-user plugin by accident. A sibling
checkout must not be required for an ordinary local task. Cross-repository work
should explicitly read the owning repository's guide rather than copy its rules.

## Verify before committing

Check frontmatter/name validity, every relative target, and the document index.
Read representative requests against the descriptions: fixing a bug, merging a
PR, releasing a version, and revising a guideline should lead to the intended
pages. Read the linked pages themselves for contradictory or stale rules.
Commit the skill, document and repaired entry links together.

A valid file and working links prove structure, not automatic selection by every
harness. Open a task in the repository and check its available skill list when
verifying native discovery. Existing chats may need their skill inventory
refreshed; use the AGENTS task map to read the entry explicitly meanwhile. Do not
claim automatic activation without observing it.

The entry for maintaining this guide is
[write guidelines](../../.agents/skills/chill-cli-write-guidelines/SKILL.md).
The other entries are [development](../../.agents/skills/chill-cli-development/SKILL.md)
and [release](../../.agents/skills/chill-cli-release/SKILL.md).
