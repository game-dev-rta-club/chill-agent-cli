---
keyPoints: >-
  Tagged distribution history; unreleased checkout changes are not listed as
  features of an existing release.
---

# Changelog

## 0.6.0

- Minor release in the pre-1.0 line. It adds features (Autonomy, Search, numbered comment references, the public link and Update on Windows) and changes documented commands, hooks, CLI JSON and stored shapes, which under 0.x is a MINOR bump with the breaking changes listed below. The SQLite schema is unchanged and no offline migration is needed. A workspace is moved once on first use (Autonomy levels, Root owners), recorded in `workspace/migrations.json`; do not start an older runtime on it afterwards. Node.js 24.15 or newer is still required. Migration: update agent instructions to the new commands (chill-agent skill 0.6.0 does this), rerun setup in Codex projects and approve the new hooks in Codex's /hooks, and let each conversation adopt its Roots again. Claude Code remains an experimental connection; Codex limits are listed under Codex.
- **Breaking:** `connection` is replaced by `agent` and `goal`. `agent show`, `agent join`, `agent wake`, `agent wait` and `agent hook` replace their `connection` forms. `connection create-goal`, `adopt`, `inbox` and `reply` become `goal create`, `goal adopt`, `goal inbox` and `goal reply`. `goal comment`, `goal letter` and `goal assign` are removed: reply with `goal reply` and take over a Root with `goal adopt`. `goal release` is new. `goal close-letter --answer` is removed, and `chill monitor` keeps only `status` and `tick`: `start`, `stop`, `enable`, `disable`, `watch` and `result` are gone. The old forms fail with an unknown command or option error.
- **Breaking:** a Root stores one owner, `{agent, id, context?}`, for Claude and Codex alike. The old `connection`, `previousConnections` and `threadId` fields are no longer read and are dropped at the next write. After the update every existing Root has no owner. Its Web comments are kept and reach a conversation once that conversation runs `goal adopt --id <Root>`.
- **Breaking:** the hooks call new commands. Setup and every update rewrite chill's Claude Code hooks (`agent hook claude`, `agent hook claude-watch`) in each recorded project. chill now finds them by their command, so a `settings.local.json` that Claude Code rewrote or reordered is refreshed too. Restart open Claude conversations after the update. The update does not refresh Codex project hooks in `.codex/hooks.json`: the old `… hook` command now fails, so rerun setup in each Codex project and approve the new `… agent hook codex` hooks in Codex's `/hooks`.
- **Breaking:** the Deliverable is now called the Canvas in the Web, help, command output and hook text. Use `goal canvas`, `--section canvas` and `--canvas-offset`. CLI JSON gives `canvasPath`, and an annotation source is `canvas`. `goal deliverable`, `--section deliverable`, `--deliverable-offset`, the source kind `deliverable` and the `/api/goals/<id>/deliverables/…` routes are refused or removed. Stored `deliverable.*` files, records and the `/briefs/` routes keep their names.
- **Breaking:** Autonomy replaces AutoContinue and Approve all. Each Root's agent has one level, Normal, Auto Continue or Never Stop, which you choose from a dropdown in the comment box (`POST /api/goals/<id>/autonomy`). On first use a Root whose AutoContinue was On moves to Auto Continue and every other Root to Normal. Approve all is not carried over. The AutoContinue and Approve all switches, extensions and APIs are removed.
- **Breaking:** only SQLite workspaces open. A JSON workspace (`workspace/schema.json`) is refused unchanged, and the error names `bin/chill-migrate.mjs`. `CHILL_AGENT_STORAGE` is removed.
- **Breaking:** every command needs a project's own data folder. Commands stop when `CHILL_AGENT_DATA_DIR` is unset, or when it names the shared `chill-agent` folder that holds `projects/`. They no longer fall back to the shared folder. Run chill through the project's command, which `setup status --project <folder>` prints. Data already in the shared folder is left in place.
- **Breaking:** `setup prepare` refuses `--agent-guide`. An application that follows the version file contract must stop passing it. Instead, feedback, the end-of-turn message and `goal create` print one Goal rule. The extension capability `agent-guidance` and the `agentGuide` export are removed, while the extension protocol stays at version 1.
- **Breaking:** notifications go only through the runtime's notification provider. Without one, `settings notifications` and `settings notice` are refused and hand-offs carry no reminder. A shared setting saved by an earlier version is not read, and `CHILL_AGENT_EXTENSIONS=none` also turns notifications off.
- Version file: the file is now named `chill-agent.json`. If a project's record still names `cli.json`, the CLI reads `chill-agent.json` from the same folder once `cli.json` is gone, so from this release on the CLI follows a reinstalled skill without a new setup. A Web still running 0.5.1 does not see the renamed file; run setup once (see the chill-agent 0.6.0 notes).
- Update: the Update button reads Updating… and then Restarting… on every open page, and the tab shows a gray updating icon while chill updates or cannot be reached. A Windows Web run by Task Scheduler now offers Update too; its update worker runs as a task of its own.
- Autonomy: at Auto Continue and Never Stop, the end-of-turn message lists the Root's unfinished Goals and asks for focused turns. In Claude Code, Never Stop holds every Stop until a check is scheduled with `agent wake`; a lower level, Pause or a Done Root ends it. The agent is told once when its level changes. A Claude tool prompt is approved when the Root the user last wrote in is at Auto Continue or Never Stop. A Root taken from another conversation starts at Normal.
- Agents: `goal reply --ask '<what to decide>'` saves the reply as a Letter. A user comment on a Goal closes the Goal's open Letters and is recorded as the answer; `goal close-letter` only withdraws a question. In the Web the user can mark a Letter Done from its heading and take it back.
- Agents: each `agent wake` adds a check instead of replacing the last one. Due checks wake the conversation one at a time, earliest first, and they survive compact and resume. `agent wake --cancel <time|all>` removes them. A check stored by 0.5.1 is not read.
- Agents: comments and Letters are numbered within their Goal as C3 and L4, and `#12 C3` names one in another Goal. The Web links these references and previews them on hover. Feedback, reply results, the end-of-turn message and `goal show` print the reference beside the event ID that commands take.
- Goals: a Root, or a Goal of another Root, can move under any Goal and takes on the destination Root's agent, Autonomy, notifications and look. A Split Goal of a Claude Root can become a Root of its own. The Goals index lists Roots newest first.
- Web: More → Search finds Goals, Comments, Letters and Canvases as you type. Every word must match, and it returns up to 50 results.
- Web: the header bell opens the Notification menu. The tab's (N) counts unanswered Letters and unread agent replies, and every device shares it. Each browser turns Letters and Replies on or off for each Root, and one Notification switch pushes what the count shows. The panel under More is gone. Replies posted while the agent works give one notification when the work ends. A notification opens in a tab of its own Root.
- Web: background tabs keep their title and icon current. The server pushes the agent status, the Letter count and the update phase over a WebSocket (`/api/goals/<id>/live`), and polling stays as the fallback. This adds the `ws` dependency.
- Web: in Activity, Think shows the newest message, three lines tall, or Thinking… while tools run. It also lists the agent's own todo list for Claude Code and Claude Desktop, only when the current turn wrote it. Running stays on while subagents run, and a closed Wait · N box lists the subagents and scheduled checks. A comment or Resume that joins a running response keeps Think's earlier text. A comment written after Pause resumes the agent.
- Web: each Root can choose its Color theme and tab icon set (Morning, Cloudy, Night) from the colored header icon. The icons are redrawn for idle, Waiting and Running, and show a yellow sun while the agent waits for a scheduled check.
- Web: images keep their size and show a blurred preview while they load, and a Canvas shows its text without waiting for them. Tables in a Canvas without its own table styles get lines. Code blocks have a Copy button, images in agent messages take annotations, E opens an annotation, and files dropped on the comment form are attached. Help steers Canvases toward visual-first HTML with text kept out of SVG, and `goal canvas update` adds a hint when a page has no visual layout.
- Claude Code: the Agent menu shows the plan's 5-hour and weekly usage. To record it, setup and updates put a small `chill-agent-usage` mod in the user's Claude skills folder. It is off in the user's settings and on in each chill project's local settings.
- Claude Code: in a conversation that owns Goals, Claude Desktop's next-step box (`wrap_up`) is refused when it carries a question or choices, and the agent is sent to `--ask`; a recap alone goes through. In Claude Desktop, `agent wait` now only keeps the conversation from being paused. The watcher hook alone delivers feedback, and the legacy reply waiter is removed. A project whose hooks predate the watcher is asked to rerun setup.
- Claude Code: the watcher keeps running after the computer sleeps, and on Windows through refused file replacements, busy leases and a locked store. It logs why it ended to `workspace/connections/claude-code/watcher.log`. A plugin's own tool calls no longer count as Claude working. A conversation's stop is held once, however many Roots it owns. The end-of-turn request is shorter, and chill records whether the turn did work.
- Codex: a Codex chat gets the same short end-of-turn request, and chill records the result. A check request that never reached the chat is closed. A turn that starts from a message chill sent shows Running at once, before its first hook. chill finds Desktop Codex without starting the app. Still limited: delivery runs on macOS only, Codex tool prompts cannot be answered by hooks, so Autonomy approvals are Claude-only, and Codex shows no todo list.
- Public link: it now runs on Windows. chill finds `cloudflared.exe`, and the connector runs as its own Task Scheduler task, so the link keeps its URL across Web updates. `settings access-code` prints the code with its end time and the link. Connected devices can show the code and the device list. The code reads as six digits without a space and has a Copy button. Turning the link On or Off discards the code. Pages are sent with `Cache-Control: no-transform`.

## 0.5.1

- Patch release, chosen by the maintainer for these compatible changes to Claude Code and the public link. Existing workspaces, connected devices and commands need no migration.
- Claude Code: a response that ends with background tasks still running shows them under Background. chill installs the SubagentStart and SubagentStop hooks to keep that list current; a list with no activity for 30 minutes shows as unknown.
- Claude Code: a conversation that has never owned a Root Goal ends its hooks before Node starts, so conversations that never use chill no longer pay about 0.15 s per hook. Creating or adopting a Goal wakes them at once.
- Claude Code: a prompt typed in the conversation clears a Web pause.
- Claude Code: in a conversation that owns Goals, AskUserQuestion, the Desktop task suggestion and ExitPlanMode are refused with a reason that sends the question or plan to a Letter. A plan goes through once the user has replied on the Web. This replaces 0.5.0's bridge that copied an in-app question into a Letter.
- Public link: a connected device can confirm an update; the computer's version file still names the package. Turning the link On or Off and disconnecting devices stay local.
- Public link: the access code is six digits, shown as `123 456`, and the connect form opens the numeric keyboard. It is still single-use, expires after 10 minutes and ends after five wrong tries.

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
