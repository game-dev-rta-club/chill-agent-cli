---
keyPoints: >-
  Fresh setup gives each real project folder its own store, Web port, runtime, theme and
  extension selection. Existing explicitly bound stores stay intact; isolate a new
  project with --isolated instead of moving existing conversations implicitly.
---

# Give each project its own workspace

A fresh `setup prepare --project /path/to/project` creates a dedicated workspace.
Its Goals, history, attachments, connection records, notification registrations,
public-link settings and prepared runtime are separate from other projects.
A public link exposes only that workspace. Each project can use a different set
of the extensions included in its installed package.

Use the exact `command` returned by setup for that project. Its `server start
--configured` chooses an available local port and prints the Web URL. Setup's
`url` is the proposed address; the server's startup output is authoritative if
another program took that port meanwhile. A running project keeps its port on
repeated setup. A stopped project reuses it when available. Quick Tunnel URLs
still change when the tunnel itself restarts.

## Prepare another project

From an already bound command, explicitly request a separate workspace:

```sh
chill setup prepare --project /path/to/another-project --isolated
```

Then use **that command's returned prefix**, including for server startup.
Add `--harness claude-code` for native Claude hooks; review new hooks in the
calling harness as described in [Claude setup](../agent/claude-setup.md).

Stores live under the normal application data directory in `projects/<id>/`.
The ID comes from the canonical project path. Symlink aliases reuse the same
store, and a linked Git worktree uses its main checkout's store, so agents
working in separate worktrees share one Web and one set of Goals. Another
folder receives a different one. Renaming a
project changes this identity. Moving existing history is not automatic.

## Select extensions

Choose at preparation time, then restart that project's Web to apply it:

```sh
chill setup prepare --project /path/to/project --isolated --extensions continuation,web-notifications,public-link
chill server restart --configured
```

Again, use the returned prefix for the restart. `--extensions none` selects no
extensions. Omitting the option preserves the saved selection; a new project
without a selection uses the package's extensions. The composed package offers
`continuation`, `notifications` (host-tool delivery), `web-notifications`, and
`public-link`. Selection does not install arbitrary extension code. Disabling
an extension retains its saved settings for future use.

## Recognize projects and Roots by color

Press the sunrise icon beside **chill.** in the header to choose the **Tab icon**
(Morning, Cloudy or Night). Open **More → Color theme** to choose the page theme,
one of six hues in Gradient, Light or Dark. The tab icon and the header icon show
the agent's state on the open Goal in the chosen set: an outline sunrise while
idle, a yellow sun with short rays while it waits for a check, and a warm sky with
long rays while it works.

Opened on a Goal, either panel saves the choice for that Goal's Root, so tabs of
different Roots in one project can look different. Opened on the Goal list, it
saves the project default, which every Root without its own choice follows field
by field. **Use project default** in Color theme removes a Root's own page theme
and tab icon. Gradient Mint with the Morning icon is the original appearance.

Choices are stored in that workspace, so a reload or another device uses the same
look; other projects are unchanged. A page opens in its Root's look from the first
paint and switches when you move to a Goal of another Root. An already open page
picks up changes when it regains focus or becomes visible. A failed save keeps the
previous choice. A store saved before Roots had their own choice reads that theme
as the project default; nothing is migrated.

The theme colors the workspace controls and reading surfaces. Status meanings
stay consistent: Letters, waiting and work in progress use amber; answered
Letters and completed Goals use green. Dark palettes adjust their contrast. Attached images
and authored HTML Canvases retain their own colors.

## Search the workspace

Open **More → Search** and type. Results show the project's Goals, Comments,
Letters and latest Canvases in which every word appears, ignoring case and
full or half width; archived Roots are left out. Goals come first, then the
newest matches, up to 50. Choose a result, or press Enter for the first one, to
open its Goal; a Comment or Letter result scrolls to that message, loading it if
it is older than the messages already shown.

Results follow the typing after a short pause, and a newer query cancels the
previous one. The server reads the workspace text at most once every few seconds
and shares it between searches, so typing quickly does not repeat the work.

## Preserve an existing workspace

An explicit `CHILL_AGENT_DATA_DIR`, including an existing stable launcher,
continues to use that store unless `--isolated` is passed. This keeps existing
links, feedback queues and native conversations intact during upgrades. Old
shared workspaces are not silently split by Goal or reassigned to new chats.

The isolation boundary is data and the local Web origin, not an OS sandbox.
Processes running as the same local user can still access the application's
files. See [data and updates](data-and-updates.md) for runtime ownership.
