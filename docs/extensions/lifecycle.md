---
keyPoints: >-
  Trusted extension modules run in the Web server process. The host serializes ticks,
  while each extension owns its policy, durable settings and busy decision.
---

# Host an extension in one server

A composed runtime includes an `extensions.json` beside `server.mjs`. It lists
relative module paths and may add CLI commands and help entries. A module exports
`createExtension()`, returning its instance. The standalone CLI has no continuation
policy manifest.

Extensions are trusted installed code, not a sandbox or browser-loaded plugins.
They share the server's process and failure domain. The host catches individual
tick failures and logs them; it cannot isolate arbitrary crashes or blocking code.

| Instance member | Responsibility |
| --- | --- |
| `id`, `label` | Unique stable identifier and readable control label |
| `start()` | Optional initialization before ticking |
| `tick()` | Optional policy check; no overlapping host ticks |
| `stop()` | Optional cleanup after the in-flight tick finishes |
| `busy()` | Whether this extension's work should delay idle shutdown |
| `read(goalId, options)` | Return a data-only Web control, or null when unavailable |
| `set(goalId, input)` | Validate and persist a control change |

The host checks once at startup, then every 30 seconds. One tick visits the
extensions in order. Shutdown prevents new ticks, waits for the current one,
then calls cleanup in reverse order. Settings writes are tracked as active host
operations too. See [server lifetime](../runtime/server.md).

`CHILL_AGENT_EXTENSIONS=none` suppresses registration for a run. It does not make
untrusted modules safe: the registry still imports manifest modules. CLI-only
distributions should omit them entirely.

## Keep the boundary explicit

Import `@game-dev-rta-club/chill-agent-cli/extension-api` and call
`requireProtocol(1)` before doing work. Use its namespaced storage and workspace
accessors instead of importing private files or inspecting the store directly.
Unsupported protocol versions fail explicitly.

`storage(namespace)` provides `read(id)`, atomic `write(id, value)` and
`lock(id, callback)` for read-modify-write operations shared by the CLI and
server. Workspace accessors include `readFeedback()` and `readGoalContext()`;
do not infer assignment or event ownership from a caller's supplied IDs.

Optional notification policy can use the
[settings provider contract](notification-provider.md) to keep CLI and Web
configuration consistent.

The application chooses policy and packages its modules. The CLI supplies
[observation and coordinated delivery](requests.md) and
[Web control rendering](web-controls.md). Its `./runtime` export provides
`copyRuntime` for composing a distributable from the allowlisted CLI runtime.

Implementation: [registry](../../lib/extension-registry.mjs),
[lifecycle host](../../lib/server-extensions.mjs), [public API](../../lib/extension-api.mjs).

`createExtension(services)` receives optional live host services. The `tunnel`
service exposes `read()`, `set(enabled, remote)` and `stop()`. A trusted extension
can own the saved public-access policy and apply it in `start()`. An explicit
extension choice takes priority over configured server startup; `--local` must
remain local at startup. The service serializes transitions, reports starting,
ready or failed, revokes the allowed public origin on stop/failure, and leaves
local Web available. It does not choose credentials, create Cloudflare accounts
or render a QR. Extension stop runs before shutdown finishes.

Use `workspacePort()` from the public extension API when building local Web URLs
or CLI command prefixes. It honors an explicit `PORT`, then the isolated
project's saved automatic port, and finally the legacy default. Re-read it after
starting a server: startup can replace a port taken by another process.
Do not hardcode 4173 in an extension. The local address is distinct from the
public origin returned by `readPublicOrigin()`.
