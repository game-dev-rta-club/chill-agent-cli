---
keyPoints: >-
  The SQLite foundation preserves numeric identities and change cursors in
  isolated workspaces. New Goal workspaces use SQLite by default; migration and cutover are
  separate work, with delivery records and editable files preserved explicitly.
---

# Build the SQLite workspace

The internal `openSqliteWorkspace` foundation creates a project-local
`workspace.sqlite` with Goal, Conversation and Brief-version tables. It requires
Node.js 24.15 or newer and uses `node:sqlite`, without a separate database service.
Goal commands and Web select SQLite for a fresh data directory. Once created,
the database is detected on later launches. Selecting `json` for that directory
is rejected to prevent a parallel store. Existing JSON installations with
`workspace/schema.json` remain JSON; there is no automatic migration.
`CHILL_AGENT_STORAGE=json` explicitly creates a legacy workspace for compatibility
testing. `CHILL_AGENT_STORAGE=sqlite` refuses existing JSON data instead of
silently converting or ignoring it.

For a disposable checkout test, set `CHILL_AGENT_DATA_DIR` to a new directory,
then use the ordinary Goal CLI and Web server. No database service or storage
variable is required.
Published Goal, Conversation and Brief records live in SQLite; editable Brief
sources and attachments keep their existing paths. Feedback delivery reads the
same event API instead of opening an event JSON file directly.

Each project owns a database. Numeric Goal IDs, event IDs, independent change
cursors and Brief versions survive reopening. The change cursor differs from the
event ID because an existing Letter can change without becoming a new event.
Indexes support parent lookups and a Goal's events after a cursor. Stored JSON
bodies retain full record contents while indexed columns support bounded reads.
Future adapters must keep these columns consistent with the public record.

Published-record operations validate and write in a single transaction and enforce foreign keys. WAL permits
readers during a writer's transaction; writers still serialize. Compound operations yield between attempts for up to
ten seconds; standalone connections have a five-second busy timeout. Goal operations reuse their transaction connection across local file reads.
Writer acquisition yields while waiting, so a second request cannot block the
Node event loop needed by the first. External calls and long work belong outside
these transactions. Editable sources are not transactional; a retried creation
preserves a source left by a rolled-back database operation.
The foundation checks its application ID and schema version before adoption and
rejects legacy JSON workspaces and unsupported database versions. No existing
store is silently converted.

## Complete the replacement in stages

1. Goal, Conversation and Brief operations now retain their validation and public
   shapes through the database. Newest Brief and changed-event queries use indexes.
   The Web client uses conversation pages and compact workspace summaries;
   the legacy compatibility snapshot still loads all history. The SQLite CLI page
   reader selects the requested Goal range and Brief body. Goal, Brief and event operations now use database transactions instead of file
   leases. Transport and extension coordination remain separate work.
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

## Read one conversation page

`GET /api/goals/<id>/conversation?limit=30` returns the newest page in ascending
change order. `limit` is 1–100; follow `nextBefore` as `before` to fetch the next
older page while `hasMore` is true. Both storage backends implement the contract;
SQLite uses `(goal_id, change_id)` to read only the requested range plus one
lookahead row. JSON retains its legacy full-file read.

`events` contains the requested page. `answerTargets` contains only the referenced
Agent Letters needed to understand its replies, including off-page Letters.
Both include rendered HTML. `cursor` is the workspace change watermark captured
with that page. A missing Goal returns 404; invalid pagination returns 400.

Event identity and change order differ: closing a Letter keeps its ID and advances
its change cursor. A client should retain the first page's watermark and reconcile
subsequent `/api/events?since=...` changes by event ID while loading history. Pages
are read snapshots, not a durable historical snapshot spanning several requests.
A cursor from a later history page must not skip intervening live changes.

The Web client requests `/api/goals?view=web&history=paged`: the newest 30
conversation records per Goal, all open Letters and referenced answer targets.
It receives Letter status metadata so an off-page reply cannot make a cached
Letter look unanswered. Older Brief versions contain metadata only. SQLite
reads the latest Brief body and indexed event ranges; JSON keeps its legacy file
reads. Letter/reply metadata still scans the Goal's records within SQLite, and
many genuinely open Letters can still grow the payload.

“Load earlier conversation” retrieves older pages on demand. Polling refreshes
the newest page and resets its history boundary when it changes; previously
loaded records are merged by event ID. Direct Letter links fetch the single
record through `/api/goals/<id>/events/<eventId>`, which rejects a different
Goal's event. Existing callers without `history=paged` retain the compatibility
snapshot. This does not yet bound the global delta API.

## Read a CLI Goal page

On SQLite, `show --id <id>` reads the selected Goal's conversation and selected
Brief body without loading other Goals' conversation history or historical Brief
bodies. `--since`, `--before` and `--limit` are applied in SQL using the Goal/change
index. A single database read snapshot supplies page counts, the global change
cursor, answer targets, hierarchy metadata and open Letters, including descendant
Letters outside the page. Brief version metadata remains available for navigation.

Omitting `--limit` intentionally returns all matching events for the requested
Goal, so a continuation using only `--since` cannot silently lose instructions.
Use `--limit` to bound a history page. JSON retains its compatibility reader.
Hierarchy/version metadata and open-Letter aggregation still grow with workspace
size; the tree command and execution/delivery lookup have separate optimization
work remaining.

Use the [offline migration rehearsal](sqlite-migration.md) to import and verify
a schema-7 copy without activating its delivery state.
