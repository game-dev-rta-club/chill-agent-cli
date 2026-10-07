---
keyPoints: >-
  A trusted notification provider makes settings commands and reminders use the
  same application policy as Web controls. The provider owns any direct delivery; the host adds no sending policy.
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
exact message and result command. A provider can also deliver directly and return
`{enabled:false, handled:true, delivery:"web-push", results:[…]}`. The caller must
not send that notification again. Outcomes are `sent`, `failed`, `unconfirmed`;
the service decides what evidence each receipt represents. The host sends
nothing and stores no credentials for external services.

No provider means the standalone CLI keeps its shared notification settings.
A configured provider that cannot load fails explicitly; it must not fall back
to a stale global On setting. `CHILL_AGENT_EXTENSIONS=none` suppresses server
extension registration, not the provider used by explicit settings commands.

The public extension API exposes shared settings readers, validation,
`saveMessageSetting`, `readPublicOrigin()` and `notificationUrl(goalId, event)`.
The origin reader returns the confirmed running connector's origin or null.
A notification extension can use it to retire subscriptions for an obsolete
public URL. Do not infer a user's device identity from its browser fingerprint.
The URL helper adds a Goal or Letter path; null is not a usable phone link.
Disabling shared notifications retains the known connection. Applications
can use this to migrate existing preferences without guessing a recipient.

Read [lifecycle](lifecycle.md) for storage and [Web controls](web-controls.md)
for rendering. Source: [provider loader](../../lib/notification-provider.mjs)
and [settings entry](../../bin/chill-settings.mjs).
