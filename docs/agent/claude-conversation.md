---
keyPoints: >-
  Native probes pass startup, new-Root binding, inbox/receipts and automatic
  feedback within a verified print-mode prompt. A finite Stop watcher also passes
  interactive prior-context qualification. Channels are unavailable in the tested
  environment. Optional Stop continuation is qualified separately; permanent idle
  delivery and live controls remain open. Explicit project setup is available.
---

# Connect the current Claude conversation

**Partly implemented: native busy delivery and finite idle wake pass qualification, including earlier context in an interactive terminal. Optional Stop continuation also passes a packaged print-mode check. Explicit project setup is available; permanent idle delivery and live controls remain open.**
Use a native Claude Code adapter for the [shared connection boundary](harness-connections.md).
The intended experience starts inside the user's Claude conversation and returns
Web feedback there. Keep ACP as an option for a separately chosen managed-session
entry, rather than using it to recreate an existing conversation.

## Match each need to a native entry point

The official [hook contract](https://code.claude.com/docs/en/hooks) exposes
`session_id`, an optional `prompt_id`, and subagent identity. `PostToolUse` can
return context during work; `Stop` can request continuation. Ordinary asynchronous
hook output waits for another turn, while `asyncRewake` with exit code 2 can wake
an idle session. Each firing creates a process without deduplication. Model
observations come from optional `SessionStart.model` and `PostModelSwitch`.

Our adapter should separate these abilities:

| Need | Proposed behavior |
| --- | --- |
| Start using chill | Bind a Root to the verified main conversation, not to its directory or a subagent. |
| Receive feedback during work | Return pending input from all Goals assigned to that connection, preserving manual holds. |
| Continue when a response ends | A composed connection extension reserves one request and returns it through a verified main Stop; the packaged print-mode qualification passes. |
| Receive input after becoming idle | An opt-in finite Stop watcher is implemented; qualify a persistent channel or renewal before promising indefinite availability. |
| Read or change settings | Expose observed model data separately from the ability to change it. Never turn a launch flag into a claim of live control. |
| Pause and resume | Holding future input is separate from cancelling a running response. Advertise cancellation only after it is verified. |

`Stop` alone does not cover Web input arriving after the hook has returned.
The [finite `asyncRewake` watcher](claude-idle.md) now implements one owner per
verified Stop, expiration and cancellation. It is opt-in, not a fallback for a
failed channel. Persistent availability and renewal remain open. Running a fresh
watcher after every tool call would create competing delivery routes.

## Make idle wake an explicit capability

[Channels](https://code.claude.com/docs/en/channels) push external events into a
running local Claude session. They require per-session opt-in, and the session
must remain running. They are a research preview with account and organization
restrictions. Anthropic authentication can use claude.ai or a Console API key;
that does not establish third-party Agent SDK subscription eligibility.

The [channel reference](https://code.claude.com/docs/en/channels-reference) describes
an MCP subprocess over stdio. The MCP SDK supplies the transport; chill would
implement the small channel adapter. A transport write is not a delivery
acknowledgement. Custom channel testing currently requires interactive development
consent; the development flag does not activate channels in print/SDK mode.

Therefore setup must report whether this particular conversation has an active
return path. Installing an MCP entry alone is insufficient. Do not restart a
user's running conversation, start a second process with its session ID, or
silently replace it to make a connection appear successful. If enabling a channel
needs a session restart, explain that requirement and preserve the user's native
resume path. A closed conversation retains pending input in chill.

Protocol negotiation is also part of qualification: the official Channels page
currently documents a registration limitation with MCP revision `2026-07-28`
on its v2 client. Do not assume that selecting the newest SDK establishes support.
Our [interactive channel probe](claude-channels.md) negotiated `2025-11-25`, but
the native terminal reported Channels unavailable before channel consent. No
channel event was sent. Its cause is unknown; MCP connectivity alone is not
evidence that this conversation can receive channel events.

## Share receipts, not transport assumptions

The proposed flow is:

```text
saved Web input / eligible Auto mode request
                  |
       reserve one request for the bound connection
                  |
        hook OR channel, selected once
                  |
      offered -> agent receipt -> completed / failed
```

The [development main-hook actions](claude-actions.md) implement new-Root ownership,
explicit inbox reads, receipts and automatic busy delivery within a verified
native prompt. They store an offer as `unknown` until the Agent claims it.
Ordinary tool hooks offer only newly saved input; explicit inbox recovers an
unconfirmed offer. Stop clears busy-prompt verification and leaves a checkpoint for the optional
finite idle watcher. Both routes use the same uncertain-offer records. Optional
[connection hooks](../extensions/connection-hooks.md) support continuation policy
without adding it to the standalone CLI. The product extension has passed a
packaged native Stop roundtrip; Channels activation remains unqualified.
Attach the same event/request ID on either route. A write with no receipt stays
unconfirmed: it cannot be labelled processed or retried through the other route.
The existing [receipt and hold rules](feedback-and-controls.md) remain the source
of truth. A reconnect does not erase those records.

Use a local connection handshake to associate the hook and channel with the
same main session. Directory equality is not identity. Keep an opaque native
session ID, optional prompt identity and a connection generation; reject stale
owners. A clear/fork or different session must not inherit a Root binding merely
because it uses the same project directory. Accept channel input only from chill's
authenticated saved events and reservations. Leave tool permissions with Claude;
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
| Concurrent routes | A hook/channel race and a reconnect produce one claimed event, never two executions. |
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
and initial-context retention within one native prompt. Separate stream-mode and
interactive probes pass receipt processing after a delayed idle wake in the same
process. The interactive test establishes conversation context before Root creation;
hooks are present from launch, so hot-installation into a running user session
is not qualified. A separate [project setup and resume check](claude-setup.md)
now passes with earlier context retained in the same native session. Native
clear/fork/interruption, channel activation, permanent idle availability and the
remaining checks above are still open. The optional product
Auto mode extension has a separate native Stop qualification; setup does
not enable it.
