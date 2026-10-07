---
keyPoints: >-
  Integrate short-lived PRs into develop without waiting for routine user review.
  The entrusted agent owns verification, serialized merges and branch cleanup;
  main remains the stable release line. Do not bypass checks or expand release authority.
---

# Keep development integrated

Use two long-lived branches: `develop` holds tested development changes and
`main` holds the stable release line. Create focused topic branches from the
latest `develop`, then return each change through a PR as soon as it is ready.
A task ends with integration or a concrete recorded blocker, not a growing pile
of locally finished branches.

This is the agreed workflow. A document does not create remote branches,
activate protection rules, publish releases or prove that CI passes.

## Responsibility and boundaries

The entrusted agent may create and review PRs, resolve ordinary integration
conflicts, and merge agreed changes into `develop` without asking the user to
review each PR. Review still means inspecting the final diff against the request,
checking dependencies and running verification; approval is not a rubber stamp.
External contributions need maintainer review unless their handling is delegated.

Version bumps, `main` promotion and public releases affect users and require
consultation with the user before execution. The agent may prepare a concrete
release candidate independently. Autonomous development integration does not
authorize distributing it or changing versions on behalf of the user.
Never weaken repository protection, skip a failing check or invent approval to
complete an integration. An unavailable credential or protection rule is a
specific blocker to report, not a reason to demand routine human code review.

## Work in small complete slices

Read status and fetch before starting. Use `feat/<topic>`, `fix/<topic>` or
`codex/<topic>` from `origin/develop`. Preserve existing work before switching;
do not reset or stash another person's changes. Keep one active topic per worker
and normally only one dependent PR waiting behind it. Integrate the prerequisite
before starting another branch on top. Independent work may use isolated worktrees.

Commit each verified milestone before switching concerns. Stage intended paths
or hunks, inspect `git diff --cached` and run `git diff --cached --check`. Commit
source, regression coverage and its explanation together when they form a usable
change. Never include generated bundles, personal runtime data or secrets. A
checkpoint is not a release. Shared history is not force-pushed as routine cleanup.

## Finish through the integration gate

1. Open a focused PR targeting `develop`. Keep incomplete work Draft and describe
   the final behavior, tests, dependency revision and rollout implications.
2. Verify a fresh checkout with its recorded dependencies. Run relevant tests
   while developing and `npm run check` before integration. Document native probes
   separately; do not run them against an active user's workspace.
3. Review the actual final diff. Integrate the latest `develop` into the topic,
   resolve conflicts and retest affected behavior plus required checks. Do not
   repeatedly rebase shared topic history.
4. Merge one ready PR at a time. Require successful repository CI on the current
   candidate and current base, or use a configured merge queue that validates
   their combination. If another PR changes the base first, refresh and recheck.
   Squash focused topic PRs into `develop`.
5. Verify post-merge CI and record the merged commit. Remove the merged remote
   and local topic branches only after checking that no active worktree, open PR
   or other worker depends on them. Resume from the updated `develop`.

Do not keep feature branches merely as backups; Git history and closed PRs retain
the work. Do not delete an old branch just because its name looks obsolete:
squash merges require checking the PR and final diff, not only Git ancestry.

When `develop` breaks, prioritize restoring it over adding work. Make a small
fix with verification when the cause is clear; otherwise revert the offending
change through a checked PR. Avoid reset/force-push recovery. Record the failure,
recovery and affected dependants so another run does not repeat the same attempt.

## Keep long runs bounded and recoverable

At each completed slice and before ending a run, check open PRs, unmerged local
commits, dirty worktrees and failed CI. Finish a ready integration before opening
another topic. Record a blocked PR's exact reason and next action in its Goal or
PR; continue independent agreed work, not repeated blind merge attempts. Ask only
when a conflict changes the intended behavior or needs a decision not delegated.

For the existing accumulated work, use one labelled bootstrap integration PR per
repository rather than pretending the changes were independent. Start `develop`
from the current remote `main`, preserve the existing topic history, review the
full delta and pass the same gate. Inventory old branches against merged PRs
before pruning. Thereafter return to small slices.

## Promote a stable version

Use a release PR from `develop` to `main` for a coherent tested version. Prefer
a merge commit to preserve shared ancestry. If protected main requires squash
and linear history, keep that protection: squash the checked promotion, then
merge main back into develop immediately and verify identical trees. This
restores the shared ancestor without reset/force-push. The synchronization adds
no new source changes and uses the already-reviewed release tree. Bring any
hotfix on `main` back into `develop` immediately.
Do not let separate long-lived release branches accumulate.

For two-repository changes, integrate the CLI first, then the app against an
exact reproducible CLI revision. A private local package replacement is not a
merge gate. The app's development dependency strategy is described in its
`docs/development/workflow.md`; stable releases pin an immutable released archive.

| State | Evidence |
| --- | --- |
| Recorded | Commit and disclosed working-tree status |
| Integrated | Merged develop PR, final checks and post-merge status |
| Running locally | Prepared runtime ID and the workspace adopting it |
| Stable for users | Main promotion and published immutable release |

Follow [Releasing](../../RELEASING.md) for archive checks and immutable tags.
Runtime updates are separate from merges and must preserve active workspaces.
Protect both long-lived branches against force pushes and deletion. Configure
required checks for `develop` without requiring routine user approval of entrusted
PRs; retain the agreed release controls on `main`. These are desired repository
settings and must be verified before relying on them.

Agent entry: [read before development](../../.agents/skills/chill-cli-development/SKILL.md).
When changing this workflow, use [guideline authoring](guidelines.md).
