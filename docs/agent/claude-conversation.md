---
keyPoints: >-
  Native probes pass startup, new-Root binding, inbox/receipts and automatic
  feedback within a verified prompt. Idle conversations wake through a background
  reply waiter rather than hooks with deadlines or Channels, which need a launch
  flag Claude Desktop cannot pass. Optional Stop continuation is qualified
  separately; live controls remain open.
---

# Connect the current Claude conversation

**Partly implemented: native busy delivery, idle wake through the reply waiter and optional Stop continuation work; live controls remain open.**
Use a native Claude Code adapter for the [shared connection boundary](harness-connections.md).
The intended experience starts inside the user's Claude conversation and returns
Web feedback there. Keep ACP as an option for a separately chosen managed-session
entry, rather than using it to recreate an existing conversation.

## Match each need to a native entry point

The official [hook contract](https://code.claude.com/docs/en/hooks) exposes
`session_id`, an optional `prompt_id`, and subagent identity. `PostToolUse` can
return context during work; `Stop` can request continuation. A finished
background task starts a new turn in an idle session. Each hook firing creates a
process without deduplication. Model
observations come from optional `SessionStart.model` and `PostModelSwitch`.

Our adapter should separate these abilities:

| Need | Proposed behavior |
| --- | --- |
| Start using chill | Bind a Root to the verified main conversation, not to its directory or a subagent. |
| Receive feedback during work | Return pending input from all Goals assigned to that connection, preserving manual holds. |
| Continue when a response ends | A composed connection extension reserves one request and returns it through a verified main Stop; the packaged print-mode qualification passes. |
| Receive input after becoming idle | The agent keeps the [reply waiter](claude-wait.md) running as a background task; its exit wakes the conversation. |
| Read or change settings | Expose observed model data separately from the ability to change it. Never turn a launch flag into a claim of live control. |
| Pause and resume | Holding future input is separate from cancelling a running response. Advertise cancellation only after it is verified. |

`Stop` alone does not cover Web input arriving after the hook has returned.

## Wake an idle conversation with a background task

Two native alternatives were tried first. A hook with `asyncRewake` can wake an
idle session, but it needs a deadline and must be re-armed after each response,
so an ordinary chat turn left no watcher behind. [Channels](https://code.claude.com/docs/en/channels)
push events into a running session, but they are a research preview enabled by a
launch flag, which Claude Desktop sessions cannot pass, and they were unavailable
in the tested terminal.

The [reply waiter](claude-wait.md) uses only a background task: it survives
unrelated turns, has no deadline, and keeps Claude Desktop from evicting an idle
session. It still cannot start a closed conversation. Do not restart a user's
running conversation, start a second process with its session ID, or silently
replace it to make a connection appear successful. A closed conversation
retains pending input in chill.

## Share receipts, not transport assumptions

The proposed flow is:

```text
saved Web input / eligible Auto mode request
                  |
       reserve one request for the bound connection
                  |
   tool hook OR waiter wake + explicit inbox
                  |
      offered -> agent receipt -> completed / failed
```

The [development main-hook actions](claude-actions.md) implement new-Root ownership,
explicit inbox reads, receipts and automatic busy delivery within a verified
native prompt. They store an offer as `unknown` until the Agent claims it.
Ordinary tool hooks offer only newly saved input; explicit inbox recovers an
unconfirmed offer. Stop clears busy-prompt verification and leaves a checkpoint for
connection extensions. The waiter never offers input itself, so both routes use the
same uncertain-offer records. Optional
[connection hooks](../extensions/connection-hooks.md) support continuation policy
without adding it to the standalone CLI. The product extension has passed a
packaged native Stop roundtrip.
Attach the same event/request ID on either route. A write with no receipt stays
unconfirmed: it cannot be labelled processed or retried through the other route.
The existing [receipt and hold rules](feedback-and-controls.md) remain the source
of truth. A reconnect does not erase those records.

Use a local connection handshake to associate the hooks and the reply waiter with
the same main session. Directory equality is not identity. Keep an opaque native
session ID, optional prompt identity and a connection generation; reject stale
owners. A clear/fork or different session must not inherit a Root binding merely
because it uses the same project directory. Offer input only from chill's saved
events and reservations. Leave tool permissions with Claude;
chill Auto mode does not enable Claude's permission relay or permission modes.

## Qualify before exposing controls

The explicit [Claude installer](claude-setup.md) shares runtime preparation while
keeping Codex setup as the default. Claude uses separate hook parsing and lifecycle
observations: its prompt ID is not assumed
to be a Codex turn ID. Keep options, quotas, cancellation and idle wake individually
unavailable until their evidence is sufficient.

| Check | Required result before claiming support |
| --- | --- |
| Existing conversation | Read and return an event in the same main conversation, with its earlier context intact. |
| Busy and idle delivery | Two Goals' replies arrive without selecting either Goal; idle delivery needs no user prompt. |
| Concurrent routes | A tool hook, a waiter wake and a reconnect produce one claimed event, never two executions. |
| Uncertain send | A missing receipt remains unconfirmed and is reconciled without blind resend. |
| Off, Pause and exit | No new Auto request after Off/Pause; held input survives; exit never launches a replacement. |
| Session changes | Resume, clear, fork and subagent hooks cannot accidentally steal another binding. |
| Unsupported features | Policy denial, unavailable model controls and stale observations display their actual limits. |

## Check startup input without a conversation

The [entry handshake](claude-entry.md) now implements a separate Claude namespace
and a generation checked by the CLI. Its native environment-handoff probe passed
with Claude Code 2.1.289. The separate main-hook action protocol can create a
new Root and confirm an explicit inbox/receipt call. With explicitly selected
native authentication, both the inbox and automatic busy-delivery model probes
passed in disposable print-mode conversations on 2026-10-06. Read those guides
for implementation, credential isolation, limitations and probes.

Run the development [startup probe](../../scripts/probe-claude-entry.mjs) with
Node.js 24 and a locally installed Claude Code executable:

```sh
node scripts/probe-claude-entry.mjs --claude /absolute/path/to/claude
```

It uses the official [`--init-only` hook path](https://code.claude.com/docs/en/hooks#setup),
which runs startup hooks and exits without starting a conversation. Two launches
use the same temporary workspace and temporary Claude configuration; ordinary user,
project and local settings are excluded. Only probe hooks and an empty MCP
configuration are supplied. Organization-managed policy still applies. The probe
does not install hooks, log in, resume a user's conversation or modify chill data.
It removes its temporary files and prints selected hook fields and check results.

The local check on **2026-10-06, Claude Code 2.1.289** observed both `Setup` and
`SessionStart` on each launch. They shared a session ID within one launch, but the
two launches had different session IDs despite using the same directory.
`SessionStart.source` was `startup`. Neither event included `model`, `prompt_id`,
`turn_id` or `agent_id`. This is evidence about init-only startup, not an assertion
that those fields are absent from an interactive run.

Consequently, a startup record must tolerate unavailable model/run observations;
it cannot mark an execution running or authenticate a Root binding merely from
the directory. Binding now also requires the main-hook action confirmation; the init-only and local tests
do not establish native model conversation continuity.
Do not synthesize a Codex turn ID from a Claude session ID.

The authenticated print-mode probes establish new-Root creation, feedback receipt
and initial-context retention within one native prompt. A Claude Desktop session
started the reply waiter from chill's next action alone, kept it through an
unrelated chat turn, was not evicted during ten idle minutes of memory pressure,
then woke for a Web reply, answered on the Web and restarted the waiter. A
separate [project setup and resume check](claude-setup.md) passes with earlier
context retained in the same native session. Native clear/fork/interruption and
the remaining checks above are still open. The optional product
Auto mode extension has a separate native Stop qualification; setup does
not enable it.
