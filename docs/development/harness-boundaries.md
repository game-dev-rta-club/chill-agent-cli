---
keyPoints: >-
  Shared skills own outcome decisions; trusted runtime adapters select setup and
  operation guidance. Native CLI implementations retain identity enforcement. Add a harness through one registry, not host branches in references.
  Core code reaches adapter code only through lib/agents/index.mjs; a test checks the import graph.
---

# Separate harness behavior from the skill

The audit found host branches in connection setup, Goal creation, feedback intake,
work selection and the standalone starter. The shared skill should not need to
know which host has a durable Queue or delivers input through hooks.

| Layer | Responsibility |
| --- | --- |
| Skill and action references | Outcomes, scope, feedback priority, useful results and common interface entry |
| `session guide --harness <id>` | Read-only selected operations, confirmation rules, next actions and constraints |
| `extensions/harnesses/<id>.mjs` | Host-specific setup options and operation guidance |
| Skill starter `scripts/start.mjs` | Checks Node.js, npm and Git, then runs `setup prepare` through npx; installs no tools and starts no Web |
| `session start` | Common isolated preparation and Web reuse; returns the selected interface and welcome sequence |
| CLI native implementation | Identity capture, Hook installation, receipt validation, actual transport and recovery |

A runtime adapter is trusted application code registered in
[the registry](../../extensions/harnesses/index.mjs). Input selects a known ID, never a
module path. Unknown IDs fail before setup; there is no default to another host.
The CLI registers `session` as a built-in extension command. The chill-agent skill
reaches this interface through the command that setup prints.
Existing CLI commands remain compatible; this change does not rewrite transport
or change the saved Root's owner.

## Use the contract

Read `session guide` before first use. Use its operation command suffix with the
established stable prefix. `operations` names creation, receipt, inspection and
work-selection routes; absent/null operations are unsupported. Follow each
operation's confirmation rule. Next actions cover
native activation; constraints retain the connection's operational limits.
`onboarding` supplies the shared ordered welcome, initial discovery Goal and
short message templates. Each adapter's `activation` supplies native prerequisites,
the user action when evidence calls for it, and its confirmation boundary. Setup
does not auto-approve Hooks or pretend browser opening happened: the agent uses
the host browser tool and checks the result. A pending native step must not hide
the running Web. The same initial Goal evolves into the user's concrete outcome.

`connectionVerified:false` means preparation did not test the native route; it
does not mean permission is missing. A Codex Root's verified conversation owner
is separate from PostToolUse Hook trust. Claude still requires its recorded
conversation identity before creation. The composed `session start` replaces the
lower-level setup `next` with this experience's next step; old setup commands
remain compatible and do not own the welcome.

The agent still identifies its actual calling host and native project directory.
The runtime does not infer identity from a model name, current Goal or directory.

Codex supports durable deferred receipts and work selection. Claude has no
deferred Queue or work heartbeat. Those
are meaningful differences, so the interface exposes them rather than pretending
both hosts share the same side effects. Current incoming feedback already carries
host-selected receipt commands; references follow those instructions without
repeating the host branches.

## Add a host

Implement and qualify the native CLI connection first. Add one adapter with its
ID, setup options and guidance, then register it. Test missing capabilities,
confirmation boundaries, unknown-host rejection and preservation of the selected
workspace. No existing common reference or skill starter needs a host branch.
Keep user-facing platform instructions in user documentation, separate from the
shared agent skill. Older probes that assert a removed host-specific Markdown
read are historical evidence only.

Current verification covers routing, setup option retention, workspace isolation,
Web reuse, packaged command availability and a disposable native Claude skill
invocation through the interface. It does not qualify another host or replace
interactive first-use approval and long-running reception tests.

## Keep harness code behind the agent interface

Core code never imports harness code directly. A harness's code is its adapter
files: everything in `lib/agents/` except `index.mjs`, `lib/claude-*`,
`lib/codex-*`, `lib/desktop-settings.mjs` and `extensions/harnesses/<id>.mjs`.
Every other file under `lib`, `bin`, `public`, `extensions` and `server.mjs` is
core. Core reaches an adapter through two doors only.

| Door | Use |
| --- | --- |
| [`lib/agents/index.mjs`](../../lib/agents/index.mjs) | Per-Root agent interface (presence, status, controls, activity, continuation, work selection, delivery carrier) and a few named exports. Its header comment lists every member. |
| [`extensions/harnesses/index.mjs`](../../extensions/harnesses/index.mjs) | Registry that selects a harness by ID for setup and `session`. |

[`test/harness-boundary.test.mjs`](../../test/harness-boundary.test.mjs) enforces
the rule from the import graph. It reads every static and literal dynamic
import, so `import {withCodex} from './codex-client.mjs'` in core fails the check.
It also fails when core code names a harness (`claude-code`, `codex-desktop`,
`CODEX_THREAD_ID`, `nativeConnection`, `harnessId`).

A core file that must pick a harness is listed in that test with its reason.
Today these are `bin/chill-hook.mjs` (Codex's own hook command),
`bin/chill-connection.mjs` (Claude Code's hook subcommands) and
`bin/chill-setup.mjs` (the harness the user names). A listed file that stops
importing adapter code fails the check, so the list cannot go stale.

When core needs something a harness provides, add it to the agent interface, not
an import. Keep the data core shares across harnesses in a core module and the
operations that talk to one harness in its adapter. A Goal's feedback hold is
the example: `lib/feedback-hold.mjs` holds the record and the `feedbackHeld`
question that every agent honors, and `lib/agents/codex-hold.mjs` holds the
Codex-only queue, interrupt and resend. The quiet-stop hold is another:
`lib/quiet-stop.mjs` decides whether a stop is held, and each harness's Stop
hook only reports the stop and returns the block. The public extension API
(`lib/extension-api.mjs`) keeps its exported names and reaches adapters through
the same index.
