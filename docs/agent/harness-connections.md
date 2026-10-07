---
keyPoints: >-
  Model settings and run observations have a native-adapter boundary and caches
  isolated per harness/session. Native Claude print-mode probes pass Root creation,
  receipts and automatic busy feedback. A finite idle watcher also passes interactive
  prior-context qualification. Optional native Stop continuation also passes its
  packaged probe. Explicit Claude project setup is available; permanent idle delivery and
  controls remain open; Channels are unavailable in the tested environment.
---

# Use chill from different harnesses

**Partly implemented: Codex boundaries and an experimental Claude busy-delivery path; broader Claude support remains in qualification.**
A user should be able to start using chill
from Codex Desktop or, later, Claude Code, and keep working in that harness's
conversation. Goal pages, Briefs and Letters provide the shared workspace. The
connected conversation retains its own history and context throughout the work.

This scope does not include transferring an existing Goal to a different agent,
recreating its context from a summary, or an Agent switcher in the model menu.
The current Codex Desktop connection stays working while additional harness
entry points and their supported operations are qualified.

## Separate the connection from the model

A Root owns one binding established from the harness where the user starts the
work; its descendants inherit it. The proposed identity contains the adapter,
connection and opaque session ID. A model is an option of that session. Existing
Roots containing only `threadId` resolve to `codex-desktop` without rewriting
their history. Provider IDs are namespaced so equal session IDs cannot collide.

```text
Codex Desktop conversation       Claude Code conversation
          |                       | (future entry)
     native adapter          native adapter / verified bridge
          \                       /
       chill: assignment, feedback receipts and holds
                         |
           Goals / Briefs / Letters / Auto mode
```

Setup recognizes the calling harness and binds its conversation. Web feedback
returns to that same conversation, including during Auto mode. A supported model
change stays within that connection. Setup must not silently start a replacement
agent when the existing conversation cannot be reached.

Delivery records retain the original connection and request identity. A change
to installation settings cannot replay queued input elsewhere. Keep connection
identity separate from work selection: a hook can surface feedback across Goals
assigned to its chat before the agent selects its next Goal.

## Let connections describe their abilities

These are proposed internal contracts, not new CLI commands or protocol methods.
A harness can use the shared workspace even when some remote controls are absent;
report such limitations explicitly rather than claiming full Auto mode support.

| Operation | Contract |
| --- | --- |
| Identify the conversation | Verify the caller and the conversation that owns the work. Preserve its context. |
| Receive feedback | Use that harness's hook or queue for the bound conversation. Reconcile uncertain delivery using the same request identity. |
| Read/set options | Return supported choices and current values. Check connection identity and expected values before changing them; read back the result. |
| Observe a run | Report queued/running/finished/unknown with run identity and evidence. Unknown is not idle; a finished run does not complete the Goal. |
| Cancel a run | Target a known run and confirm its terminal state. Missing support remains unavailable. |
| Continue autonomously | Deliver the next action request into the bound conversation without losing its context, bypassing a pause or starting duplicate work. |

Chill owns durable receipts and holds. Native transport and reconciliation belong
to each adapter. Pause holds the relevant input and may cancel a known run;
resume delivers the preserved input. A protocol's cancellation method alone is
not this complete behavior. A disconnect after dispatch remains uncertain and
does not permit automatic repetition. Keep permission handling with the harness;
Auto mode does not change its permission policy.

## Keep the existing model menu

Read model choices and effort settings from the connected harness. Preserve its
IDs and labels, and refresh dependent choices after a change. Do not map Claude
settings onto Codex's enum. Keep Model prominent and identify the current harness
nearby; no Agent-switch control is required by this design.

Account quotas, session context usage and monetary cost remain separate metrics.
Show the information actually available from the connection; missing data is
unavailable, not zero.

## Integrate in small steps

The [model-settings boundary](model-settings.md) and [run observation boundary](execution-state.md)
are implemented for the existing Codex Desktop connection. Native model, usage,
queue and run reads and conditional settings writes live in its adapter. Shared
validation and caches use the harness and session identity. Other connections do
not read Codex's persisted control records or heartbeats. Root storage and Web
settings payloads still use the legacy `threadId`.
That refactor alone does not enable a Claude native return path.

The [Claude entry handshake](claude-entry.md) now passes native session identity
and a connection generation to the CLI in isolated qualification sessions.
Experimental [main-hook actions](claude-actions.md) add new-Root ownership,
explicit inbox reads and receipts, with request IDs for crash recovery. A verified
native prompt also receives new input on ordinary main-session tool hooks. Context
IDs separate clear/fork from resume/compact. Local protocol tests and authenticated
print-mode probes pass. An opt-in [finite Stop watcher](claude-idle.md) also passes
native stream-mode and interactive prior-context checks. These use hooks configured
at launch, not hot-installed into an existing user session. Permanent idle delivery,
packaged user-facing installation and live controls remain unqualified or unavailable.
Experimental project hooks can be installed through [explicit setup](claude-setup.md). Optional
[connection hooks](../extensions/connection-hooks.md) now support the product Auto
mode policy; its packaged native Stop probe passes independently of Channels.
The [Channels probe](claude-channels.md) reached MCP initialization but native
channel activation was unavailable; it sent no channel notifications.

| Current code | Intended boundary |
| --- | --- |
| Setup, hook input and Root `threadId` | Calling-harness identity and a backward-compatible binding |
| `lib/codex-client.mjs`, `lib/desktop-settings.mjs` | Existing Codex Desktop adapter; retain supported-path checks |
| `lib/agent-status.mjs`, `public/agent-menu.js` | Connection facts and dynamic settings, preserving the current UI |
| `lib/delivery.mjs`, `lib/agent-control.mjs` | Shared receipts/holds and native transport/reconciliation |
| `lib/agent-observation.mjs`, `lib/extension-api.mjs` | Provider-neutral facts, request identity and fresh validation |

First wrap and verify the working Codex path. For Claude, qualify the entry point,
caller identity and return path to the **same** conversation before choosing a
transport library. Verify feedback across Goals, completion receipts, interrupted
work, manual Pause, Auto mode continuation and unavailable controls. No successful
check may depend on silently moving work into a fresh agent.

The [Claude conversation proposal](claude-conversation.md) maps this boundary to
native hooks and an optional channel. It separates feedback during work from idle
wake, and describes the evidence required before either is advertised as supported.

The [library comparison](harness-options.md) remains useful for transport
selection. ACP is a candidate if a future entry point explicitly uses a managed
session from the start. Its ability to create a session does not establish that
it can attach to the user's existing Claude Code conversation. Managed-agent
creation is a separate design choice, not a substitute for the current outcome.
