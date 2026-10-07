---
keyPoints: >-
  Workspace data lives outside the checkout. Setup prepares a content-addressed runtime
  and stable launcher; running servers keep their snapshot until explicitly restarted.
---

# Keep data separate from installed code

Fresh setup allocates a [separate workspace for each project](projects.md).
Within a workspace, use one data directory for the CLI, Web server, project hook and any composed
application that shares the workspace. `CHILL_AGENT_DATA_DIR` overrides the
default. On macOS the default is `~/Library/Application Support/chill-agent`;
elsewhere it is `$XDG_DATA_HOME/chill-agent`, falling back to
`~/.local/share/chill-agent`.

| Area | Purpose |
| --- | --- |
| `workspace/` | Goals, Brief versions, Conversation, attachments and coordination records |
| `settings/` | Shared notification and remote-access preferences |
| `runtime/` | Prepared code snapshots, installation pointer and server records |

These paths explain ownership, not a storage API. Use CLI commands and the
[public extension API](../extensions.md), rather than editing internal JSON.
The editable Brief path returned by `goal brief path` is the intended exception.

## Prepare once, use the stable command

From a built checkout on the supported macOS Desktop integration:

```sh
node bin/chill-entry.mjs setup prepare --project /path/to/project
```

Setup copies an allowlisted runtime into `runtime/packages/<content-hash>/`,
registers it, and installs a project hook that calls `runtime/chill.mjs`. It
returns the exact reusable command prefix. Review a new or changed hook's trust
in Codex; setup does not change trust records or unrelated hooks.

The launcher belongs to its data directory. Use a separately prepared launcher
for another store; pointing this launcher at a different directory is rejected.

For explicit experimental Claude project hooks, use
[Claude setup](../agent/claude-setup.md). It uses the same runtime preparation
with separate native hook installation. Omitting the harness selector retains
the Codex behavior above.

## Update without moving the workspace

Prepare from the new package with the same data directory. New CLI invocations
use the newly registered snapshot. An already running server still uses its
previous snapshot. Run `chill server restart --configured` when ready to adopt
the new version. This replaces Web while keeping its separately managed Tunnel
and public URL. `server stop` remains a full shutdown. A source checkout update or plugin-cache change alone does not replace
the running files. Old snapshots are not automatically deleted.

Verify saved Goals, history and pending feedback after a runtime update. Back up
the data directory before migrations: reverting code does not undo data changes.
Unsupported workspace schemas are rejected rather than silently interpreted.
See [server controls](server.md) and [release maintenance](../../RELEASING.md).

Implementation: [data directory](../../lib/data-directory.mjs),
[runtime preparation](../../lib/runtime-package.mjs), [setup](../../bin/chill-setup.mjs).
