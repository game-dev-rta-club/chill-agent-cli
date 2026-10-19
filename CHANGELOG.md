---
keyPoints: >-
  Tagged distribution history; unreleased checkout changes are not listed as
  features of an existing release.
---

# Changelog

## 0.5.0

- Minor release in the pre-1.0 line. Codex Desktop and Claude Code now run on one set of agent rules, and Claude Code is a complete connection beside Codex. Existing SQLite workspaces need no migration.
- **Breaking:** Brief is renamed Deliverable everywhere users and agents see it: Web labels, `goal deliverable` (`goal brief` names its replacement), `--deliverable-offset`, `--section deliverable`, `deliverable.md`/`deliverable.html` sources and `deliverable*` fields in CLI JSON. Earlier `brief.*` sources move to the new names once; stored records keep their internal names. The Deliverable holds only the final output; plans and progress belong in Conversation.
- **Breaking:** the public link no longer opens for anyone with the URL. A device connects once with an 8-character access code shown only on the computer; the QR opens the link and the code is typed. Connected devices are listed in the panel and disconnect one by one or all at once.
- Claude Code: Web feedback reaches the same conversation through a watcher hook or a `connection wait` reply waiter. One waiter runs per conversation, a stale one is taken over, and a waiter that stops checking ends itself and wakes its conversation. `connection wake` schedules a check while waiting on CI, shown in Web as Waiting. Pause/Resume, Queue and Approve all work from the Agent menu; Approve all never answers the user's questions. A question Claude asks in its own app appears as a Letter on its Goal until it is answered.
- Agent state: Running, Queued, Paused, Interrupted, Waiting and Ended follow one set of rules for both harnesses, with background subagents counted as Running. Several agents can work in one project, each with its own Root, and a continued Claude conversation can take over its Goals.
- Feedback: comments saved while the agent works wait for that work to end (Send now hands one over at the next step). Letters are answered with an ordinary Comment that the agent records. `#N` links to Goal N and each Goal shows where it is mentioned. `/skill` suggestions hand the named skill's files over. Any file can be attached, and attached images can be annotated.
- Deliverables: HTML Deliverables render in an isolated frame and accept annotations; wide screens show the Deliverable beside the Conversation.
- Notifications cover every agent reply, with a Letters-only choice per device.
- Web defaults are English and locale-neutral. The Sand theme is replaced by Lime; a saved Sand choice falls back to the default theme.
- Release checks run the user-visible scenarios on the installed Codex and against recorded Claude Code samples, besides the fakes.

## 0.4.0

- Minor release in the pre-1.0 line for the SQLite storage transition. Compatibility and migration history are recorded in the [0.4.0 release notes](https://github.com/game-dev-rta-club/chill-agent-cli/releases/tag/v0.4.0).
- Require Node.js 24.15 or newer. Use built-in SQLite for new workspaces, indexed Goal/Brief/conversation reads, transactional record writes and reusable coordination leases; no separate database service or native dependency build is needed.
- Retry SQLite WAL recovery contention within the existing bounded waits, without replaying transaction callbacks or feedback.
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
