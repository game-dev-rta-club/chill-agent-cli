---
keyPoints: >-
  The current target preserves the calling harness conversation. ACP remains a
  candidate for explicitly managed sessions; no reviewed library has yet been
  verified as an attachment to the user's existing Claude Code conversation.
---

# Select a harness integration

**Research from 2026-10-06, scoped to the revised outcome.** The user wants to
use chill from different harnesses while preserving the calling conversation.
The [connection design](harness-connections.md) makes that requirement explicit.
Keep the existing Codex Desktop path. Choose a Claude transport only after
verifying its entry point and return path to that same conversation.

The comparison below was originally aimed at new managed sessions. Those
capabilities remain relevant if such an entry point is later chosen, but do not
prove attachment to an existing Claude Code conversation. No library is adopted
or qualified through a live integration test yet.

## Transport candidates

For the current outcome, investigate the [native Claude entry](claude-conversation.md)
first: hooks for session observations and in-turn input, with a channel transport
for explicitly enabled idle wake. This uses the existing conversation instead of
requiring a library-owned one. It remains a proposal pending live qualification.

- [HarnessRouter](https://github.com/HarnessRouter/harnessrouter) provides a service
  with sessions, streaming and cancellation. Its [self-hosted setup](https://github.com/HarnessRouter/harnessrouter/blob/main/docs/self-hosting-guide.md)
  uses Docker, a Console/Gateway/Runner and provider credentials. That is useful
  for a shared execution service, but adds more operational surface to this local
  application than the proposed ACP client.
- ACP has [Codex](https://github.com/agentclientprotocol/codex-acp) and
  [Claude Agent SDK](https://github.com/agentclientprotocol/claude-agent-acp) adapters.
  It fits client-managed sessions and dynamic model settings. Existing Desktop
  queue and IPC compatibility remains unverified, so the existing adapter stays.
- [twaldin/harness](https://github.com/twaldin/harness) offers CLI invocation and
  selected controlled sessions, but explicitly excludes Codex app-server sessions.
  It is not a substitute for the current long-lived Desktop connection.

- [Vercel AI SDK Harnesses](https://ai-sdk.dev/docs/ai-sdk-harnesses/overview)
  normalize full sessions and output into AI SDK primitives. The packages are
  experimental; its [Codex and Claude adapters](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-adapters)
  use sandbox bridges. It is worth considering if chill adopts that execution
  and UI stack, but is broader than this connection-only change.
- [Triad Harness SDK](https://github.com/Triad-Labs-Inc/harness-sdk) is a local
  TypeScript library with Codex/Claude adapters. Its [architecture](https://github.com/Triad-Labs-Inc/harness-sdk/blob/main/docs/architecture.md)
  owns sessions, a persistent queue, storage and process supervision. It explicitly
  does not attach to arbitrary terminal processes. It is the closest all-in-one
  alternative; selecting it would require deciding which existing chill session
  and delivery responsibilities move into the SDK. ACP would keep that managed-session migration smaller; neither proves existing-conversation attachment.
- [lite-harness](https://github.com/LiteLLM-Labs/lite-harness) offers a common
  SDK format, but its README still describes an unpublished preview.
  [AgentAPI](https://github.com/coder/agentapi) exposes terminal agents over HTTP,
  but declares itself deprecated and unmaintained. Neither is the first choice
  for this new integration.

## Qualification limits

For a separately authorized managed-session trial, the pinned candidates are `codex-acp` v2.1.1 and `claude-agent-acp` v0.86.0,
whose release manifests were inspected. Main-branch features are not treated as
proof of released behavior. Pin the complete dependency resolution before a trial.
Claude's adapter requires Node 22 or newer; the core CLI currently supports Node 20,
so an optional worker needs its own runtime requirement.

Authentication is part of qualification for an SDK-managed session. The [official Claude SDK guide](https://code.claude.com/docs/en/agent-sdk/overview)
directs third-party products to API-key authentication unless separately approved.
Do not promise that a user's existing Claude subscription is reusable merely
because an adapter supports login. This proposal does not introduce key storage,
provider charges or a new login flow. Native Claude Code Channels have their own
authentication and organization requirements; see the native-entry proposal.
