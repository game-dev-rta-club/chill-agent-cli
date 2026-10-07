---
keyPoints: >-
  Extensions share a More menu, settings panels, browser context and confirmation
  dialogs. Descriptors can expose active counts and Goal-linked run logs without sending work.
---

# Expose controls without a custom frontend

Return a descriptor from `read(goalId, {activity, clientId})`. The host adds the instance's
`id` and `label`. A basic toggle returns `{rootId, enabled}`; use
`placement: 'header'` to show it in the header's **More** menu. Each row displays
the extension's name, icon and On/Off state on both phones and computers.
The frontend chooses from fixed
icons: `icon: 'repeat'` is the coffee motif and `icon: 'bell'` is a bell,
with a generic fallback. `description` supplies short header help.
It does not accept extension HTML, scripts or arbitrary icon markup.

GET `/api/goals/:id/extensions` requests controls. A same-origin JSON POST to
`/api/goals/:id/extensions/:extensionId` sends `{rootId, enabled}`. The host rejects
unknown extensions and non-boolean enablement. The extension must validate root
ownership and persist the change; its `set` method is the authority for that
configuration. Return null when the control does not apply to the selected Goal.

The fixed controls are not a general UI plugin system; broader control types
need a host change.

## Offer setup through the assigned Agent

Use `configured: false` with `setup: {label: 'Set up', text: '…'}` when a toggle
would not work yet. The Agent menu shows that action instead of On/Off. On a
configured control, the same field offers a small Change action. `detail` adds
a short second-line value, such as the selected destination.

A click saves `setup.text` as user feedback on the selected Goal, through the
normal delivery and pause controls. It does not run extension code or send an
external message. The UI reuses a request ID on retry and marks an accepted
request Requested. Extensions should describe the setup task and any required
user choices, not assert that the click approved a recipient or a test send.

## Add an activity view

When `activity: true` is requested, a descriptor may include:

```js
activity: {
  label: 'AutoContinue',
  activeCount: 0,
  total: 1,
  entries: [{
    id: 'stable-entry-id',
    at: '2026-10-05T00:09:00Z',
    summary: 'Check for anything missed in the completed Goals.',
    message: 'The exact request text',
    status: 'Result received',
    detail: 'Optional short context',
    result: { label: 'No work reported', at: '2026-10-05T00:10:00Z' }
  }]
}
```

The Agent menu requests this with `?activity=1`. Normal header reads omit it.
The same query on POST returns fresh activity alongside the saved control.

Supply newest-first entries with stable IDs and bound the list in the extension.
`total` counts available history; `activeCount` counts only pending or running
requests. Zero active requests displays Empty even when history exists. Omitting
`activeCount` omits the badge rather than treating missing evidence as zero.

The host renders text, preserves multiline messages, and puts history below the
On/Off toggle. Store the actual sent text; return `message: null` if an old record
does not contain it. Never regenerate an old message from a newer template.
Keep current enablement separate from past requests and their reported results.

For execution logs, use `activity.runs` instead of `entries`. The host places
these under **Agent → Activity → Recent runs**, separate from the extension's
switch. Each run supplies `id`, `at`, `status`, optional `result`, a saved
`goalId` / `goalTitle`, and `logPath` within its extension API. The host combines
the most recent 20 runs and escapes all displayed text.

Opening **Run log** calls that path with `?goalId=<viewed-goal>`. Its GET handler
validates ownership and the saved run ID, then returns `{work, message, error}`.
`work.messages` contains public agent text; completed logs can be cached, while
active or unavailable logs can be refreshed. Reading a log must not enqueue work.
Older `entries` remain supported for non-execution extension history.

Reading controls or history must not create Conversation events, send new work,
renew an idle deadline, or reset policy counters. Agent presence is a separate
[host-owned observation](../agent/execution-state.md).

Implementation: [control host](../../lib/server-extensions.mjs),
[routes](../../server.mjs), [Agent menu](../../public/agent-menu.js).

## Open a small panel

More menu rows open a common, non-modal panel; opening never changes enablement.
Without a custom panel, the host renders the existing toggle and description.
`menu: false` hides a descriptor from the Agent menu while keeping its header
control. `manifest` can name an asset under that extension's own URL prefix.

A trusted extension can return `panelModule: '/extensions/<id>/panel.js'`.
The module exports `mount({element, control, goalId, clientId, api, changed, signal, confirm})` and
may return a cleanup function. It renders into `element`; `api(path, body?)`
addresses only `/api/extensions/<id>/…`. `changed()` refreshes shared indicators.
Use the abort signal for fetches and clear timers when the panel closes. The
host preserves the header button through polling and closes the panel on route
change, outside focus or Escape.

The instance's `assets` is an exact filename map to `{file: URL, type}`. No
filesystem path comes from a browser request. Assets are served under
`/extensions/<id>/`. A service worker can explicitly declare `scope: '/'`.
Only install trusted modules: these browser assets share the application's
origin and are not sandboxed. Package their files under `extensions/` so runtime
snapshots retain them.

Optional `request({method,path,query,body,origin,local})` handles GET or same-origin
JSON POST and returns `{status?,body}`. Validate every input and enforce your
operation's authority. `local` identifies a request to the loopback hostname;
remote callers must not be allowed to enable publishing just because they can
view Goals. A service-worker receipt may omit Origin only when Fetch Metadata
reports `same-origin`. Requests are counted as host work during shutdown.

## Keep header controls aligned

Use a named host icon (`repeat`, `bell`, `globe` or the generic fallback). The
host owns the menu and gives each row a 52px hit area and 24px icon slot;
its More trigger has a 44px hit area. Icon paths
use a 24×24 viewBox, with the visible body centered at (12,12); optional details
such as coffee steam may extend above the body. Both On and Off must keep that
body in place. New icons belong in the host catalog, so extension authors do
not need CSS offsets or size overrides. The Agent mascot uses the same control
height, with its face optically centered and antenna above it.

Names and states are visible in the More menu; descriptions belong in the panel
and accessible help. Agent header help closes while a settings panel is open. Do not add a native
`title` to a trigger that already has the shared tooltip; native tooltips cannot
be dismissed reliably by the panel. Keep keyboard help in `aria-describedby`.

For browser-local preferences, `clientId` is a stable local-storage UUID shared
between a header read and its panel. It is null when storage is unavailable.
The GET controls route accepts `?clientId=<UUID>`; without it, a device-specific
control should not claim another device is On. The ID is preference context,
not authentication or authorization. Extensions still validate every mutation.

## Ask for a consequential change

A custom panel may await `confirm({title, message, confirmLabel, cancelLabel})`.
It returns true only for the confirm button, and false for Cancel, Escape or a
panel/route abort. The host renders a styled HTML dialog, contains keyboard
focus, and initially focuses Cancel. It uses DOM controls instead of a blocking
JavaScript `window.confirm`, so browser verification can read and operate it.
Use it to explain the scope of publishing or a similarly consequential change;
do not add confirmation to routine switches. Browser permission requests still
use their browser-owned API inside the user's original gesture.
