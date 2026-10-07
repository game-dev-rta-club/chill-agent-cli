# Working in this repository

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[development workflow](docs/development/workflow.md) before changing source.

Preserve existing work. Use a topic branch and commit each verified, coherent
milestone before switching concerns or handing back the result. Review the
staged diff; do not include unrelated files or generated/personal runtime data.
At handoff, report the commit and any intentionally remaining changes. A local
runtime update is distinct from a Git commit, a push and a release.

For cross-repository work, identify the tested CLI revision and whether the
committed dependency reproduces the result. Do not mark a dependent app branch
ready while it only works with an unrecorded local dependency replacement.
