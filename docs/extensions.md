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

The CLI supplies mechanisms. The integrating application owns scheduling policy,
request wording and its journal. The standalone CLI does not include AutoContinue;
[chill-agent](https://github.com/game-dev-rta-club/chill-agnet) supplies that policy.

The current source of the public exports is [extension-api.mjs](../lib/extension-api.mjs).
Check the version you package: optional capabilities can be added within protocol v1.
