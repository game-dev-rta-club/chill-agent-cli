---
keyPoints: >-
  Tagged distribution history; unreleased checkout changes are not listed as
  features of an existing release.
---

# Changelog

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
