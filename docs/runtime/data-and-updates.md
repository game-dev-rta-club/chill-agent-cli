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
registers it, and installs a project hook that calls the short `runtime/chill`
entry. That entry runs `runtime/chill.mjs` with a Node path that survives
Homebrew upgrades, falling back to the Node on PATH. Setup returns it as the
reusable command prefix. Review a new or changed hook's trust
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

## Update from Web

An application can register `runtimeUpdates` in its trusted `extensions.json`.
On a managed macOS server, the local Web shows an update icon when the installed
skill selects a different application commit. Confirming it acquires the candidate,
prepares a snapshot and restarts Web at the same URL. Closing the confirmation
leaves the current version running. Detection alone never downloads or activates
code. Public links do not expose the update action: they do not authenticate an
administrator. Foreground and Windows servers retain the explicit CLI update path.

The updater uses a separate launchd worker so replacing Web cannot kill its own
update. It rechecks the selection before switching, coalesces simultaneous clicks,
and restores the previous program if restart fails. This recovery does not reverse
schema migrations. Diagnostics remain in `runtime/update.json` and the per-attempt
log. An unresponsive operation is not automatically resent.

The provider exports `createRuntimeUpdates()` with `current()` (the immutable
running commit), `candidate(directory)` (`{key}` or null, read-only), and
`acquire(directory, key)` (a verified built runtime path). Commit keys are full
40-character hashes. It owns the package-specific pin format and acquisition;
the CLI owns snapshots, restart and same-origin/local-only request handling.
Use `saveRuntimeUpdateSource` / `readRuntimeUpdateSource` from the extension API
for the installed skill's durable source reference. Neither paths nor package
URLs are accepted from browser input. Providers must bound downloads and verify
that the acquired package matches the confirmed key.

Run `node test/runtime-update-native.mjs` on macOS for an isolated launchd
roundtrip. It uses disposable code and data and verifies the URL, Goal records,
request restrictions and completed receipt; it does not touch a user's server.
