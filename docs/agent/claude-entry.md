---
keyPoints: >-
  A development-only SessionStart handshake passes Claude's native session and
  a fresh generation to the CLI. It rejects stale or mixed identities without
  assigning Goals or advertising delivery, authentication or live controls.
---

# Identify the calling Claude session

The experimental `connection` command qualifies the first step of the
[Claude connection](claude-conversation.md): getting the calling conversation's
identity into chill without substituting a Codex thread or looking up a Goal
by its directory. It is not a complete Claude integration. The development-only
[main-hook actions](claude-actions.md) now add explicit new-Root creation, inbox
reads and receipts on top of this identity.

In an isolated development session, configure `connection claude-hook` as a
native `SessionStart` command. The hook checks the main-session input and
writes its identity variables to Claude's
[environment handoff file](https://code.claude.com/docs/en/hooks#persist-environment-variables),
replacing its own earlier lines and keeping other hooks' lines.
Use the same chill data directory when invoking `connection show` from that
environment. Help describes the command contract:

```sh
node bin/chill-entry.mjs connection --help
node bin/chill-entry.mjs connection claude-hook --help
node bin/chill-entry.mjs connection show --help
```

An explicit [Claude setup option](claude-setup.md) installs the project-local
hooks. The default Codex setup does not. Use the probe below to try the handshake
without modifying the user's environment.

## Keep different conversations separate

Records live under `workspace/connections/claude-code/`. Native session IDs are
opaque and hashed for filenames. The hook exports the harness, session ID and
a new connection generation. `show` requires all three to match the saved
record. A missing field, another data directory or an old generation fails;
there is no Codex or directory-based fallback.

Every accepted SessionStart rotates the generation, including resume, clear,
compact and fork. A separate context ID survives resume and compact when a
valid previous record exists; startup, clear and fork create a new context ID.
Root ownership uses this context ID so clear cannot inherit previous Goals. Earlier shell environments for the same session become stale.
Starts for distinct native IDs stay separate even in the same folder. Concurrent
starts for one ID leave only one current generation; consumers must recheck it
before future mutations. Subagent hooks and events other than SessionStart
cannot replace the record. An export failure leaves the old registration intact.

This is coordination between trusted local processes, not an authentication
boundary. Environment variables may be inherited, including by subprocesses or
subagents, and same-user processes can alter local files. Goal binding
and delivery additionally use the [main-hook action protocol](claude-actions.md);
this does not protect against a malicious same-user process.
The record may outlive the process: it never proves that a conversation is open,
running or idle. Model data, prompts and transcript contents are not read.

## Reproduce the check

With Node.js 24, a POSIX shell and the installed Claude executable:

```sh
node scripts/probe-claude-entry.mjs --handshake --claude /absolute/path/to/claude
```

The probe creates temporary Claude settings, config and chill data. It runs two
`--init-only` invocations without a model conversation, invokes the actual hook
command, and sources Claude's exported environment in a child shell to run
`connection show`. Temporary files are removed even on failure. Normal settings,
existing chats, authentication and production Goals are untouched.

On 2026-10-06, Claude Code 2.1.289 passed startup identity and environment-handoff
checks in both invocations. This confirms the native startup file and CLI path,
not a later model-initiated Bash call, resume/clear behavior in a live conversation,
or feedback delivery. Generation rotation, subagent filtering, concurrent starts,
shell quoting and failure handling are covered by `test/claude-entry.test.mjs`.

`connection show` reports the identity stage with capability flags false and a
separate [recorded connection status](claude-status.md). It distinguishes a running
reply waiter and recorded session exit without enabling controls. Its exported
shell environment cannot establish a main-session return path.
Explicit main-hook actions have separate persisted confirmations. A confirmed
native prompt can also receive feedback on ordinary tool hooks; SessionStart
identity alone does not enable that route. Settings and execution controls remain
unavailable. Replies after a response ends use the [reply waiter](claude-wait.md),
which a compact in the same context keeps. The broader
qualification checks remain in the [connection proposal](claude-conversation.md#qualify-before-exposing-controls).
