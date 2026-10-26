---
keyPoints: >-
  Explicit Claude setup adds project-local hooks without changing permissions or
  other hooks. Every preparation and update replaces chill's own hooks with the
  current version's, so a rewritten or deleted settings file heals; status reports
  configuration, not live activation. A conversation that was already running
  connects with connection join, without resuming. A Git worktree shares its
  main checkout's project; native tool permissions are answered only by Autonomy Auto Continue or Ultra Continue.
---

# Prepare hooks for a Claude conversation

The experimental Claude route has an explicit setup option. From a built CLI or
composed application, select the project whose local settings Claude will read:

```sh
node bin/chill-entry.mjs setup prepare --harness claude-code --project /absolute/project
```

Codex remains the default when `--harness` is omitted. The Claude route does not
look up Codex. It prepares the [stable runtime](../runtime/data-and-updates.md)
and adds SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse,
Stop and SessionEnd hooks to `.claude/settings.local.json`. It does not start
Claude or the Web server, raise a Root's Autonomy, assign an existing Goal, or change
native permissions.

PermissionRequest answers Claude's permission prompts with Allow only when the [Autonomy](../workspace/goals.md#autonomy-how-far-the-agent-goes-on-its-own) of the conversation's Roots asks for it: it owns a Root and every Root it owns is at Auto Continue or Ultra Continue (Claude only); otherwise prompts ask as usual. Prompts Claude Code never lets a hook approve still ask. PreToolUse applies a [Web pause](claude-status.md#pause-resume-and-queue) to every tool call. For Bash it also keeps unattended work from stopping at a prompt. Claude
Code asks a person before `rm` or `rmdir` whose target is a glob or trailing
slash directly under a shell variable, such as `rm -f $DIR/*.png`, even in
bypass mode, and no allow rule or hook may approve it (its
[critical paths](https://code.claude.com/docs/en/permission-modes#critical-paths)
check). The hook finds that form first and denies it with a reason asking Claude
to rewrite it as `rm -f "${DIR:?}"/*.png` or with a literal path, which Claude
Code accepts. It never approves a command. Other commands pass without output;
the check adds about 0.15 seconds per Bash call.

Each hook is the same shell command on every platform: it runs the short `chill`
entry, which uses the recorded Node or, if that is gone, the Node on PATH. On
Windows, Claude Code runs hooks and the Bash tool in Git Bash, so setup stops
with an installation hint when Git Bash is not found (it also honours
`CLAUDE_CODE_GIT_BASH_PATH`). Hooks written as exec form by an earlier Windows
setup are replaced on the next prepare. PowerShell and cmd can use
`runtime\chill.cmd`, which runs the Node on PATH.

The installer preserves other settings and hooks. chill's own hooks, those
that run `connection claude-hook` or `claude-watch`, are replaced with the
current version's every time, whatever they look like now, so repeating setup
does not add duplicates. Claude Code rewrites this file, in its own key order,
when it saves its own settings there; a hand edit of a chill hook is put back,
and a person's hook in the same group stays. Symlinked local settings are
rejected. No backup of credential-bearing settings is copied.

Claude's [settings locations](https://code.claude.com/docs/en/settings#where-claude-code-keeps-the-local-file-in-a-repository)
matter: a conversation in a linked Git worktree also loads the main checkout's
local file. Setup therefore treats a worktree as its main checkout: the hooks go
to the main checkout's `.claude/settings.local.json`, and every worktree shares
that project's data, Web and Goals. Conversations stay separate by their native
session. A local file created outside Claude may need an entry in your
repository's ignore rules. Setup does not modify global Git
excludes, user settings or managed policy.

## Activate it in the same conversation

Review the configured hooks when Claude asks. A conversation started after setup
receives its identity at SessionStart. A conversation that was already running
connects with `connection join`: Claude names its session in every shell.
Claude loads hooks written during a conversation for its next
tool call, so no resume is needed. Do not clear, fork or launch a concurrent copy
as a connection repair.

Use the exact command prefix printed by setup for these main Bash calls:

```sh
chill connection show
chill connection join        # only when show reports no connection
chill connection create-goal --title 'The agreed outcome'
```

`show` verifies only the current native identity handoff; `create-goal` creates
the Root at once. The project directory alone never selects a conversation. See
[connection actions](claude-actions.md)
for feedback and reply handling. Native policy, hook disablement or permissions
may still prevent activation; setup does not override them.

Setup and installed hook messages use the same short entry, `<data>/runtime/chill`.
It records a Node path that survives Homebrew upgrades and falls back to the
Node on PATH if that binary disappears. Runtime updates keep that entry usable. Direct
checkout invocations keep their own entry; they do not borrow a different store's
installation.

A version update (the Web's Update button, or a changed version file at server
start) also brings the hooks setup recorded for each project up to the new
version, for example when it handles a new event, and writes them again where
the settings file was rewritten or deleted. Only chill's own hooks are replaced.
A project whose hooks were removed is left as it is. So a teammate only pulls
the project and presses Update; setup is needed once per machine.

## Allow the operations you intend to delegate

Claude may ask to read the plugin's references and run chill commands. These are
native tool permissions: at Autonomy Normal chill does not answer them, and it never
grants tools in Claude's own settings. With one-time permissions, later Web feedback can reach the conversation
but replying to it can still wait for another Bash approval.

Follow [Leave a Claude conversation working](claude-unattended.md) to review the
actual operations, try one Web reply and recover without sending it twice.
Trusting a folder, reviewing hooks, permitting tools and raising a Root's Autonomy
are distinct choices. Setup does not grant tools or change native permission mode.

## Receive replies and remove the hooks

Setup installs only the conversation hooks. Replies after Claude goes idle wake
it through the [watcher hook](claude-wait.md) among them; there is nothing to
configure here. In Claude Desktop the agent also starts `connection wait` as a
background task when a chill result asks for it, only so that Desktop does not
pause the conversation.

```sh
chill setup status --harness claude-code --project /absolute/project
chill setup remove --harness claude-code --project /absolute/project
```

Status reads local configuration without calling Codex or claiming a live return
path. Remove preserves other hooks, native permissions, Goals and delivery
records. Neither command interrupts a running response. Allow any in-flight hook
to finish and use native hook controls for the current session.

The Agent panel continues to identify this as an experimental connection. It
does not offer unverified model settings or execution controls; usage comes
from [Cache Keep](cache-keep.md). Optional
continuation extensions are separate from installation; with `CHILL_AGENT_EXTENSIONS=none`
no end-of-turn check is sent.

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
the previous context, successful full-reference read, Root binding and replies.
The eight-minute wall limit bounds the session; interactive mode has no dollar
budget. Authentication is imported only when explicitly requested and is not
copied into the report. Normal settings and production Goals are untouched.

The interactive flow was last exercised on **2026-10-06 with Claude Code
2.1.289**, when feedback arrived through a finite idle hook that has since been
replaced by the watcher hook. Rerun it before relying on first-use onboarding
with the watcher.
