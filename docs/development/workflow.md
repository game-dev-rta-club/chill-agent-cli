---
keyPoints: >-
  Use short-lived branches from main, commit tested milestones, and review focused PRs.
  Source commits, installed runtimes and published releases are separate states;
  dependent application changes wait for an explicitly adopted CLI release.
---

# Keep changes reviewable and reproducible

A contributor should be able to clone a reviewed revision, install its recorded
dependencies and reproduce its checks. Use a lightweight
[GitHub flow](https://docs.github.com/en/get-started/using-github/github-flow):
`main` is the integration branch, and each focused change uses a short-lived
branch. A separate permanent `develop` branch is not needed for our current
release model. Users install tagged releases; work in progress stays on branches.

## Start with a known state

Read `git status --short`, the current branch and the relevant guide before
editing. Fetch the current remote state when connected. From a clean checkout,
create a branch from `origin/main`, for example `feat/project-workspaces` or
`fix/resume-replies`. Agent branches may use `codex/<topic>`.

Keep unrelated work on separate branches/worktrees. When work already exists,
identify its owner and preserve it before switching; do not reset, stash or
rewrite someone else's work just to obtain a clean status. A branch needed by
another branch is an explicit dependency, not a new unrelated base.

## Commit at a useful milestone

Commit after a focused behavior and its relevant verification are complete,
before moving to another concern or handing work back. Examples include a
reproduced bug with its fix, a working API with regression tests, or a coherent
documentation update. Code, the test that protects it and its usage explanation
can belong in the same commit. Do not wait until the end of a long session.

Before committing:

```sh
git status --short
git diff
# Stage the intended files or hunks explicitly.
git add -- path/to/file
git diff --cached --check
git diff --cached
```

Use a short outcome-oriented title such as `fix: resume feedback after idle`.
Record material verification or limitations in the body when needed. Do not
commit generated bundles, local runtime data, personal hook commands or secrets.
A commit is a reviewed checkpoint, not a claim that the feature is released.
Avoid automatic timed commits of unreviewed working trees.

At handoff, inspect status again. Commit completed work and state the branch,
commit and verification. If unfinished changes must remain, identify them and
why. Never describe a dirty working tree as fully recorded. Already-shared
history is not rewritten as routine cleanup.

For accumulated changes that cannot safely be separated, record one explicitly
labelled integration checkpoint with known test results and limitations. Keep
that recovery exception out of normal day-to-day work; do not invent a sequence
of small commits that only appears independently functional.

## Review and merge

Use one PR per user-visible concern and open a Draft for incomplete or dependent
work. The PR describes the problem, final behavior, verification and remaining
risks. Update it when scope changes. A branch depending on unreleased CLI APIs
is not ready merely because a local replacement package passes.

Run focused tests while developing and `npm run check` before marking Ready.
Verify the final revision, not just an earlier state. A fresh checkout should
pass `npm ci` and its documented check. Native Claude/Codex probes are explicit,
isolated integration runs: document what was actually exercised separately from
portable unit tests. Do not run them against active user workspaces.

Require a maintainer review and the repository CI checks before merging. Prefer
squash merging a focused PR into `main`; its milestone commits remain visible in
the PR history. Delete the merged topic branch when no dependent work needs it.
For maintainers, recommended [branch protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
requires PRs and successful checks, and blocks force pushes/deletion of `main`.
These are settings to verify in GitHub, not settings this document activates.

## Keep source, local installation and release distinct

| State | Evidence |
| --- | --- |
| Recorded locally | Branch and commit, with remaining working-tree changes disclosed |
| Reviewed for integration | PR and checks on its final revision |
| Running locally | Prepared runtime ID and the store/server that adopted it |
| Available to users | Published release tag and installable archive |

Follow [Releasing](../../RELEASING.md) for immutable tags and clean archive tests.
A commit, `npm pack`, or local setup alone does not publish a release or restart
an existing Web server. Preserve active workspaces during development.

For the composed app, the CLI is released first. The app then adopts that exact
archive and regenerated lockfile in a dependency PR and repeats clean checks.
Until then, record the local CLI commit/archive used and keep the dependent app
branch in Draft. Never replace the public dependency with a personal file path.
