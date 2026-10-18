---
keyPoints: >-
  Claude Code data in tests is built from redacted samples recorded from one
  release, and a contract test fails when chill reads a field those samples lack.
  Hook shapes come from the release's own hook schema, not recorded stdin.
---

# Keep Claude Code test data tied to a real release

Tests that feed chill hook input or transcript lines build them with
[test/claude-fixtures.mjs](../../test/claude-fixtures.mjs). The helper starts from
samples under `test/fixtures/claude-code` and a test overrides only the fields it
cares about. No test file declares its own hook or transcript shape.

## What is recorded

`scripts/record-claude-samples.mjs` writes the samples from local Claude Code
data, read only. It never runs `claude` or changes settings.

- **Transcripts.** For each entry kind chill reads, it takes the smallest real
  window from `~/.claude/projects`. Keys, types and the marker strings chill matches
  stay. Every other string becomes `(redacted)`, and IDs, timestamps, paths and
  names are replaced. The script audits every string it writes, so an unexpected
  field is refused instead of copied. Review the fixtures before committing them.
- **Hook input.** Claude Code does not keep the stdin it sends to hooks, so the
  fields come from the hook input schema inside the Claude Code binary of the same
  release, which is the code that builds that stdin. `hooks.json` says so in its
  `source`. Treat these as the release's declared shape, not as captured payloads.

`manifest.json` names the release each sample came from. Record again after Claude
Code updates. The script uses the release with the most recorded lines. Pass
`--claude-version <x.y.z>` to choose another, and `--binary <path>` when its binary is
not under `~/Library/Application Support/Claude/claude-code` or
`~/.local/share/claude/versions`.

## What the contract test checks

[test/claude-contract.test.mjs](../../test/claude-contract.test.mjs) fails with the
field and the sample it is missing from when:

- a hook field chill reads is absent from the release's hook schema or has another type,
- a transcript entry kind or field chill reads is absent from the recorded samples,
- chill reads a hook or transcript field the contract does not declare, or
- the readers give a wrong answer on a recorded turn, interrupt, feedback offer,
  background subagent or task notification.

When chill starts reading a new field, add it to `hookReads` or `entryReads` in that
test. If no recorded sample carries it, record one before relying on it.
