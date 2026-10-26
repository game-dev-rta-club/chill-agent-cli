---
keyPoints: >-
  Protocol v1 separates policy from host-owned execution coordination. Follow the
  lifecycle, request and Web-control guides to integrate a trusted extension.
---

# Extension API v1

Use `@game-dev-rta-club/chill-agent-cli/extension-api` and call
`requireProtocol(1)` before work. Do not depend on private modules or storage files.

| Concern | Contract |
| --- | --- |
| Register trusted code and manage its lifetime | [Lifecycle](extensions/lifecycle.md) |
| Observe the chat and enqueue without racing other work | [Execution requests](extensions/requests.md) |
| Show enablement, active work and request history | [Web controls](extensions/web-controls.md) |
| Detect and apply an explicitly confirmed runtime update | [Runtime updates](runtime/data-and-updates.md#update-from-web) |
| Extend a verified native action or Stop | [Connection hooks](extensions/connection-hooks.md) |

The CLI supplies mechanisms. The integrating application owns scheduling policy,
request wording and its journal. The CLI's own end-of-turn check follows each Goal's
[Autonomy](workspace/goals.md#autonomy-how-far-the-agent-goes-on-its-own); it shows no Web control.

The current source of the public exports is [extension-api.mjs](../lib/extension-api.mjs).
Check the version you package: optional capabilities can be added within protocol v1.

For a packaged agent-policy entry point in handoffs, see [agent guidance](extensions/agent-guidance.md).
