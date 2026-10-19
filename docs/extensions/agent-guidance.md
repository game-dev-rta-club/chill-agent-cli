---
keyPoints: >-
  A trusted runtime manifest can name a packaged Markdown entry point for agent
  handoffs. Relative paths survive runtime copying; the CLI also works without a guide.
---

# Connect application guidance to a handoff

An application can keep its agent policy in its own skill while the CLI handles
saved feedback and delivery. Add an optional relative Markdown path to the
trusted `extensions.json` manifest:

```json
{"agentGuide": "skills/example/SKILL.md"}
```

Package the entry and its references together. Runtime preparation copies the
optional `skills/` directory recursively and includes its contents in the
snapshot hash. The guide must resolve to a file inside that runtime. Preparation
does not change the plugin loaded in the user's editor.

Feedback delivery prints the resolved entry path for every harness: in the
Codex message and in the context a Claude hook adds. Without a manifest guide,
it is the guide recorded at setup (`--agent-guide`), which belongs to the main
checkout, so an agent in a worktree with an older copy of the skill still
reaches the current guide. Delivery does not load or execute the instructions. The agent chooses relevant references from the entry point.
Without a configured guide, delivery retains a compact generic workflow.

The public extension API exposes `agentGuide()` and the `agent-guidance`
capability so an extension can point to the same entry. It returns an absolute
path or null if no guide is configured. Invalid configured paths fail rather
than silently naming an unrelated file. `goal-context` identifies support for
`show --section context`, described in [reading Goals](../workspace/reading-goals.md).

Keep the application policy in that guide, not in a second copy of the delivery
text. This is optional packaging metadata, not a new server or a place for
user-submitted instructions.

Implementation: [guide resolution](../../lib/agent-guidance.mjs),
[runtime copy](../../lib/runtime-package.mjs), [delivery](../../lib/delivery.mjs).
