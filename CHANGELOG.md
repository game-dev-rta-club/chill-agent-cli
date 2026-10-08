---
keyPoints: >-
  Tagged distribution history; unreleased checkout changes are not listed as
  features of an existing release.
---

# Changelog

## 0.4.0

- Minor release in the pre-1.0 line for the SQLite storage transition. SQLite workspaces cannot be opened by 0.3.x; this is an incompatible persisted-data change, not a 1.0 compatibility commitment.
- Require Node.js 24.15 or newer. Use built-in SQLite for new workspaces, indexed Goal/Brief/conversation reads, transactional record writes and reusable coordination leases; no separate database service or native dependency build is needed.
- Keep existing schema-7 JSON workspaces on their existing backend. Upgrading code does not automatically migrate or split data. To move to SQLite, back up and stop writers, [create and verify an offline migration bundle](docs/runtime/sqlite-migration.md), then reconcile connections, unresolved feedback and settings before explicit cutover. Activation is not a one-command operation; never remove the pending marker as a shortcut. Downgrading code does not roll back SQLite data or later messages.
- Page older Web conversations on demand and stabilize reading position across Goal/Letter navigation and asynchronous Activity, Brief and diagram updates.
- Archive unused root Goals without deleting their history; exclude them from normal lists and continuation discovery.
- Clarify Letters as requests for necessary replies, with ordinary results in Comments.
- Keep experimental Claude restrictions: a running same-session receiver and finite watch are required. Windows automatic Web startup and Desktop integration remain unsupported; portable contracts are checked separately.

## 0.3.0

- Minor feature release in the 0.x line; existing workspaces and commands remain supported. No data migration is required. Existing shared stores are not automatically split.
- Add project-isolated stores and Web ports, retained Tunnel URLs on Web restart, and faster Goal navigation.
- Add 18 project color themes, theme-aware browser toolbar colors, counted header Letters and current Activity pause/resume controls for supported Codex connections.
- Add experimental native Claude setup, same-session ownership and resume reception. Claude must remain running; finite idle watches are not a background service or an overnight guarantee.
- Improve delivery recovery, user controls and extension composition. Keep extension protocol versions independent of package versions.
- Establish checked release metadata and change-based version selection.

## 0.2.0

- Add a trusted notification settings provider, receipt command and locked extension storage.
- Support bell controls, setup requests and destination details in extension history.
- Retain the notification connection when disabled.
- Ship the compact Goal index, Agent presence, activity history and responsive controls.
- Preserve conversation line breaks and prioritize active execution over Done badges.

## 0.1.0

- First standalone chill-agent-cli distribution.
- Preserve existing Goal data and stable runtime commands.
- Versioned extension contract and independently tested package archives.
