---
keyPoints: >-
  A trusted notification provider makes settings commands and reminders use the
  same application policy as Web controls. The host never sends external messages.
---

# Connect notification policy to settings

Add `notificationProvider: './lib/your-policy.mjs'` to the composed runtime's
`extensions.json`. That module exports a `notifications` service with these
methods:

| Method | Called by |
| --- | --- |
| `settings(goalId?)` | `settings show` and notification reminders |
| `configure(goalId, input)` | `settings notifications --id …` |
| `prepare(goalId, eventId)` | `settings notice` |
| `result(goalId, noticeId, outcome)` | `settings notice-result` |

The service owns Root selection, saved profiles, event eligibility, message
reservation and receipts. `settings` returns at least `enabled` and `on` for
reminders. `prepare` returns `{enabled:false}` to skip, or a tool, destination,
exact message and result command. Outcomes are `sent`, `failed`, `unconfirmed`;
the service decides what evidence each receipt represents. The host sends
nothing and stores no credentials for external services.

No provider means the standalone CLI keeps its shared notification settings.
A configured provider that cannot load fails explicitly; it must not fall back
to a stale global On setting. `CHILL_AGENT_EXTENSIONS=none` suppresses server
extension registration, not the provider used by explicit settings commands.

The public extension API exposes shared settings readers, validation,
`saveMessageSetting` and `notificationUrl(goalId, event)`. The latter only
returns a confirmed running phone URL; null is not a usable phone link.
Disabling shared notifications retains the known connection. Applications
can use this to migrate existing preferences without guessing a recipient.

Read [lifecycle](lifecycle.md) for storage and [Web controls](web-controls.md)
for rendering. Source: [provider loader](../../lib/notification-provider.mjs)
and [settings entry](../../bin/chill-settings.mjs).
