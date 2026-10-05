---
keyPoints: >-
  Extensions return data for a shared toggle and optional activity history. Active
  counts exclude finished requests; reading history must not send work or reset policy.
---

# Expose controls without a custom frontend

Return a descriptor from `read(goalId, {activity})`. The host adds the instance's
`id` and `label`. A basic toggle returns `{rootId, enabled}`; use
`placement: 'header'` to show it beside the agent. The frontend chooses from fixed
icons: currently `icon: 'repeat'` is the coffee motif, with a generic fallback.
It does not accept extension HTML, scripts or arbitrary icon markup.

GET `/api/goals/:id/extensions` requests controls. A same-origin JSON POST to
`/api/goals/:id/extensions/:extensionId` sends `{rootId, enabled}`. The host rejects
unknown extensions and non-boolean enablement. The extension must validate root
ownership and persist the change; its `set` method is the authority for that
configuration. Return null when the control does not apply to the selected Goal.

Header help currently uses continuation-specific copy. The fixed controls are
not a general UI plugin system; broader control types need a host change.

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

Reading controls or history must not create Conversation events, send new work,
renew an idle deadline, or reset policy counters. Agent presence is a separate
[host-owned observation](../agent/execution-state.md).

Implementation: [control host](../../lib/server-extensions.mjs),
[routes](../../server.mjs), [Agent menu](../../public/agent-menu.js).
