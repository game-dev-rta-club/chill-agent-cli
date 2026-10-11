---
keyPoints: >-
  Explicit Claude setup adds project-local hooks without changing permissions or
  other hooks. Repeating preparation reconciles owned entries; status reports
  configuration, not live activation. Native resume preserves the existing chat;
  native tool permissions remain separate from chill Auto mode.
---

# Prepare hooks for a Claude conversation

The experimental Claude route has an explicit setup option. From a built CLI or
composed application, select the project whose local settings Claude will read:

```sh
node bin/chill-entry.mjs setup prepare --harness claude-code --project /absolute/project
```

Codex remains the default when `--harness` is omitted. The Claude route does not
look up Codex. It prepares the [stable runtime](../runtime/data-and-updates.md)
and adds SessionStart, UserPromptSubmit, PostToolUse, Stop and SessionEnd hooks
to `.claude/settings.local.json`. It does not start Claude or the Web server,
enable Auto mode, assign an existing Goal, or change native permissions.

The installer preserves other settings and hooks. It replaces only its exact
recorded entries, so repeating setup does not add duplicate hooks. Edited or
untracked chill hooks are reported instead of overwritten. Symlinked local
settings are rejected. An interrupted write retains enough ownership information
to reconcile either settings version on the next prepare, without copying a
backup of credential-bearing settings.

Claude's [settings locations](https://code.claude.com/docs/en/settings#where-claude-code-keeps-the-local-file-in-a-repository)
matter: a Git project or worktree may use the main repository's root local file.
Choose that directory explicitly. A local file created outside Claude may need
an entry in your repository's ignore rules. Setup does not modify global Git
excludes, user settings or managed policy.

## Activate it in the same conversation

Review the configured hooks with Claude's native `/hooks`. Hook-file changes and
a successful settings write do not establish the SessionStart environment required
by chill. If that handshake has not run in the current chat, use Claude's normal
exit and resume flow to reopen **that same conversation**. Do not clear, fork or
launch a concurrent copy as a connection repair.

Use the exact command prefix printed by setup for these main Bash calls:

```sh
chill connection show
chill connection create-goal --title 'The agreed outcome'
```

`show` verifies only the current native identity handoff. The main hook confirms
the new Root separately. Keep its returned command and identity; the project
directory alone never selects a conversation. See [main-hook actions](claude-actions.md)
for feedback and receipt handling. Native policy, hook disablement or permissions
may still prevent activation; setup does not override them.

Setup and installed hook messages use the same stable CLI prefix, including the
canonical data-directory path. Runtime updates keep that entry usable. Direct
checkout invocations keep their own entry; they do not borrow a different store's
installation.

## Allow the operations you intend to delegate

Claude may ask to read the plugin's references and run chill commands. These are
native tool permissions: turning on chill Auto mode does not answer them or grant
tools. With one-time permissions, later Web feedback can reach the conversation
but handling its receipt can still wait for another Bash approval.

Follow [Leave a Claude conversation working](claude-unattended.md) to review the
actual operations, try one Web reply and recover without sending it twice.
Trusting a folder, reviewing hooks, permitting tools and enabling chill Auto mode
are distinct choices. Setup does not grant tools or change native permission mode.

## Receive replies and remove the hooks

Setup installs only the conversation hooks. Replies after Claude goes idle use
the [reply waiter](claude-wait.md), which the agent starts as a background task
when a chill result asks for it; there is nothing to configure here.

```sh
chill setup status --harness claude-code --project /absolute/project
chill setup remove --harness claude-code --project /absolute/project
```

Status reads local configuration without calling Codex or claiming a live return
path. Remove preserves other hooks, native permissions, Goals and delivery
records. Neither command interrupts a running response. Allow any in-flight hook
to finish and use native hook controls for the current session.

The Agent panel continues to identify this as an experimental connection. It
does not offer unverified model settings, usage or execution controls. Optional
continuation extensions are separate from installation; the standalone CLI has
no Auto mode policy.

Implementation: [installer](../../lib/claude-setup.mjs),
[setup entry](../../bin/chill-setup.mjs). Qualification uses the disposable
`scripts/probe-claude-auto.mjs --setup-resume` against a composed runtime.

On **2026-10-06, Claude Code 2.1.289**, all 15 checks passed: a conversation
first ran without chill hooks and saved its context; the explicit installer then
added project hooks; native `--resume` reopened the same session, retained the
earlier token, created one Root and completed one Auto-mode follow-up. Unrelated
local settings/hooks survived. Ordinary Claude settings and production chill data
were unchanged. This verifies exit-and-resume in a disposable print-mode test,
not hot-installation into a running interactive chat or a packaged native skill
installation.

For first-use interactive qualification, run
`scripts/probe-claude-onboarding.mjs --help`. It uses a disposable project and
default native permissions with no pre-granted tools. It first saves a conversation
without hooks, explicitly prepares the project, resumes that session with the
packaged Skill and waits for synthetic Web feedback. The operator approves the
specified individual test operations and exits after each phase. It verifies
the previous context, successful full-reference read, Root binding and receipts.
The eight-minute wall limit bounds the session; interactive mode has no dollar
budget. Authentication is imported only when explicitly requested and is not
copied into the report. Normal settings and production Goals are untouched.

The interactive flow was last exercised on **2026-10-06 with Claude Code
2.1.289**, when feedback arrived through a finite idle hook that has since been
replaced by the reply waiter. Rerun it before relying on first-use onboarding
with the waiter.
