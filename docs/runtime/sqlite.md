---
keyPoints: >-
  The opt-in SQLite foundation preserves numeric identities and change cursors in
  isolated workspaces. Goal commands still use JSON; migration and cutover are
  separate work, with delivery records and editable files preserved explicitly.
---

# Build the SQLite workspace

The internal `openSqliteWorkspace` foundation creates a project-local
`workspace.sqlite` with Goal, Conversation and Brief-version tables. It requires
Node.js 24.15 or newer and uses `node:sqlite`, without a separate database service.
It is not yet connected to Goal commands, setup or Web. Existing installations
continue using their JSON stores; there is no automatic migration.

Each project owns a database. Numeric Goal IDs, event IDs, independent change
cursors and Brief versions survive reopening. The change cursor differs from the
event ID because an existing Letter can change without becoming a new event.
Indexes support parent lookups and a Goal's events after a cursor. Stored JSON
bodies retain full record contents while indexed columns support bounded reads.
Future adapters must keep these columns consistent with the public record.

Writes use short synchronous transactions and enforce foreign keys. WAL permits
readers during a writer's transaction; writers still serialize with a five-second
busy timeout. Long work and asynchronous calls belong outside a transaction.
The foundation checks its application ID and schema version before adoption and
rejects legacy JSON workspaces and unsupported database versions. No existing
store is silently converted.

## Complete the replacement in stages

1. Connect Goal, Conversation and Brief operations to the database, retaining
   their public shapes and validation. Read bounded pages and indexed changes;
   putting an all-history scan inside SQL would retain the scaling problem.
2. Exercise Web, CLI and harness delivery in a disposable project. Inventory
   coordination records separately: delivery receipts, holds, connection identity,
   extension state and pending requests are not part of the foundation tables yet.
3. Import a copy with original IDs, timestamps, references and delivery states.
   Verify counts and contents before enabling delivery; imported pending records
   must not send themselves during validation. Keep editable Brief source paths,
   attachments and their references intact. Settings and runtime remain separate.
4. Stop old writers for the final import, verify it and switch readers and writers
   together. Back up first and test restoration. An old JSON copy alone does not
   restore messages created after cutover; rollback needs to account for them.

The first usable SQLite build and migration are separate milestones. Publishing
or changing a running installation is also separate from merging this foundation.
SQLite improves indexed storage access; harness-status queries and Web payload
size still need their own measurement.

Implementation: [SQLite foundation](../../lib/sqlite-workspace.mjs).
See [existing data ownership](data-and-updates.md) and
[project isolation](projects.md).
