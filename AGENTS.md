# Working in this repository

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[development workflow](docs/development/workflow.md) before changing source.

Use short-lived topic branches from develop and PRs back to develop. For work
entrusted to the agent, own review, successful checks, serialized merge and branch
cleanup without waiting for routine user review. Version bumps, main promotion and public releases
require user consultation before execution. Read the workflow for dependency and merge gates.

Preserve existing work. Commit each verified, coherent
milestone before switching concerns or handing back the result. Review the
staged diff; do not include unrelated files or generated/personal runtime data.
At handoff, report the commit and any intentionally remaining changes. A local
runtime update is distinct from a Git commit, a push and a release.

For cross-repository work, identify the tested CLI revision and whether the
committed dependency reproduces the result. Do not mark a dependent app branch
ready while it only works with an unrecorded local dependency replacement.

## Read this for the current task

- Implement, test, commit or integrate: [development](.agents/skills/chill-cli-development/SKILL.md).
- Change guidelines or their task triggers: [write guidelines](.agents/skills/chill-cli-write-guidelines/SKILL.md).
- Prepare a stable release: [release](.agents/skills/chill-cli-release/SKILL.md).

Read the matching entry when skills are not auto-discovered. Reuse guidance
already read; the documents it links are authoritative for project conventions.
