---
keyPoints: >-
  Create and verify an offline SQLite migration bundle without modifying a legacy
  schema-7 workspace. Preserve record identities and all original files; archived
  delivery state is never activated. Restoration and live cutover remain separate.
---

# Rehearse a legacy workspace import

Use Node.js 24.15 or newer from this CLI checkout. These commands import only
storage code; they do not start Web, contact a harness, deliver messages, install
hooks or update a runtime. Stop source writers for a consistent snapshot. For an
initial rehearsal, a before/after content inventory detects observed changes and
rejects that run; it is not a substitute for quiescing writers at final cutover.

```sh
node bin/chill-migrate.mjs create \
  --source /absolute/old-data/workspace \
  --destination /absolute/new-offline-bundle
node bin/chill-migrate.mjs verify --bundle /absolute/new-offline-bundle
```

The destination must not exist, its parent must exist, and it must be outside the
source. Only schema-7 JSON workspaces are accepted. Symbolic links and special
files are rejected, and an existing SQLite database makes a source ambiguous.
The source is read only. A private staging directory is removed on ordinary
failure; an interruption can leave a `.pending-*` directory or incomplete target.
Such a directory is not a verified bundle and must not be used as a workspace.
Keep the source intact and use a new destination for the next attempt.

## Inspect the bundle

| Item | Contents |
| --- | --- |
| `records/workspace.sqlite` | Goals, events and Brief versions with original IDs, change cursors, relations and exact original JSON bodies |
| `source.ndjson` | One entry per original file: relative path, permission bits, byte length, SHA-256 and base64 content |
| `manifest.json` | Format/version, source inventory digest, archive digest, counts and `offline-review` state |

The archive includes editable Brief files, images/attachments, delivery receipts,
requests, holds, connection state, extension state, lock history and other workspace
files. It is intentionally inert: those entries do not live at active runtime
paths. Empty directories, ownership and filesystem timestamps are not preserved;
record timestamps inside JSON and all file contents are preserved. Runtime binaries,
project registry and settings outside the selected workspace are not included.
Treat the bundle as private data; its archive is not encrypted.

Do not set `CHILL_AGENT_DATA_DIR` to this bundle. It is an offline migration and
recovery input, not an installable data directory. In particular, never activate
archived pending delivery, leases or connection identities merely by copying them
into a running workspace.

## Understand verification

Creation applies SQLite foreign keys and rejects duplicate IDs/change cursors,
Goal cycles and dangling annotation sources. A parent may have a larger numeric
ID than its child; deferred foreign keys preserve that valid ordering. The import
retains IDs instead of assigning new ones, including gaps and changed Letter
cursors. It compares the source inventory again before publishing the result.

Verification reads the database read-only, checks its identity/schema and integrity,
compares every imported JSON body's bytes against the archived original, checks
indexed columns against record contents, and verifies counts and both SHA-256
inventories. Auxiliary data is byte-preserved, not interpreted as permission to
resume work. A checksum is an integrity check, not proof that an untrusted bundle
came from an authorized author.

The process reads one file payload at a time. Inventory and path metadata remain
in memory; import is a one-time full scan, not a normal workspace read path.
A transaction may span local file reads because this is a private, offline database.

## Continue toward cutover

After a real copy passes verification, test restoring the original files to a
separate directory and compare bytes. Define activation separately: editable files
and attachments stay as files, while receipts must retain their semantics without
replaying completed or uncertain sends. Historical lock files are evidence, not
live leases. Inventory and prepare settings outside the workspace independently.
Only then stop all writers for a final import, verify it, and switch the application
as one operation. Recovery must account for messages written after cutover, not
just restore the old snapshot and lose them.

See [SQLite runtime stages](sqlite.md) and [data ownership](data-and-updates.md).
