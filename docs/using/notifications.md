---
keyPoints: >-
  The count in the tab title and the browser notification are separate. Each browser
  chooses per Root whether Letters and Replies count; Notification sends it what its
  count shows. Both live in the Letters menu. Replies wait until the agent's work ends
  and only unread ones are announced. Changing the public URL retires old registrations.
---

# Hear when your attention matters

Open a Goal and open the envelope, the **Letters** menu in the header. It has
three switches:

- **Letters**, beside the Letters heading: count questions that need your
  decision. The agent marks a reply that asks you to decide or approve something,
  and it arrives as a Letter. A Claude conversation that owns a Goal never asks in
  its own app.
- **Replies**, beside the Replies heading: count other replies from the agent, such
  as results and Claude conversation replies.
- **Notification**, the last row: send this browser what its count shows.

The two count switches decide what the tab title and the envelope show. They need
no permission, and a new browser or project starts with both On and Notification Off.
Letters Off leaves unanswered Letters listed in the menu; only the count skips them.
Replies Off hides the unread replies too. A reply counts once the agent's work ends,
the moment a notification would announce it, and replies saved before this version
of chill do not count.

Turn Notification On and allow the browser's permission request. A confirmation
arrives a few seconds later. Tap it to return to the Goal. This browser then receives
what it counts for that project (the Root Goal and its children), and the envelope
shows a small bell. Because a notification sends what the count shows, you cannot
hear about a kind without counting it. With both count switches Off, Notification
turns Off and cannot be turned On.

Each device has its own switches: a phone, or a browser on another computer. Turn
them Off on one device; the other devices' choices stay unchanged. The Goals index
has no Root, so these switches appear only on a Goal.

For your phone, open **More → Public link** on your computer and scan its QR. On iPhone,
add the page to your Home Screen and open that app first. Then turn on Notification in
the phone's Letters menu. Permission belongs to that browser and URL. If previously
blocked, change the browser's site settings before trying again.

## Control interruptions

Keep only **Letters** on to hear only when a reply, choice or permission is
needed. With **Replies** on, an unread reply counts in the tab title and appears
under Replies in the Letters menu until you open its Goal or choose **Mark all
read**; see [Web navigation](../workspace/web-navigation.md). Opening a notification shows that reply in its Conversation,
in a tab already open on the same Root: one showing that Goal, else the one used
last, found by its address. With no such tab it opens a new one, so a tab of another
Root keeps its page. A tab opened before an update comes forward but stays on its
page until it is reloaded. A device set
up before these switches keeps what it was sent: every reply turns both counts on,
Letters only turns on Letters, and Notification stays On.

While the agent is still working in a Root, its replies there wait; work only in
its other Roots holds nothing back. When the work ends, the
replies you have not read yet become one notification: the newest, with how many
more there are. A reply you already read while the work went on, such as "On it",
sends nothing. For an agent that chill continues itself, the work must stay ended
for 45 seconds, since it pauses briefly between turns. Letters never wait.

Web notices new replies by itself, for Codex and Claude alike, so no Agent command
is needed. An Agent's `settings notice` request for the same reply sends nothing
more: each reply reaches a device at most once. Your own comments, progress,
Canvas saves and end-of-turn checks (Autonomy) do not send Web notifications. A reply saved
while Web was stopped is not sent later if Web notices it more than 30 minutes
after it was saved. The one-time confirmation after the first switch On is only a setup check. Turning
a switch on does not replay old posts. Both Off cancels this device's pending
notifications; a request already handed to the push service can still arrive.
It retains the registration and browser permission for later use.

Delivery receipts remain internal. Push-service acceptance alone does not prove
an alert appeared; browser and OS settings can suppress banners. Failed or
uncertain sends are not automatically retried. Reconnecting an expired
subscription requires turning a switch on again.

The computer must be awake and able to reach the push service. Closing the Web
page does not prevent delivery. Keys and subscriptions stay in local data
outside the repository, with private file permissions.

## Public access is separate

The [Public link panel](public-link.md) opens or closes access from other devices. Notifications Off
does not close it. While the public link is Off, alerts may arrive but their
Goal links cannot open remotely. A different temporary URL needs each device to
register again. Once a new public URL is confirmed, registrations for the previous
URL stop receiving notifications. This avoids sending to both an old and a new
subscription on the same device. Other devices registered at the current URL
remain independent; the app does not guess which physical device a browser is.
A fixed URL avoids that change.

Registering the same push subscription again keeps a single recipient, even if
site storage was reset. Preparing the same reply more than once also sends it
only once per subscription. A single device using separate browser profiles can
still have separate registrations; turn Off in any profile you do not want.

Existing host-tool notification profiles remain available through the CLI and
message-setup skill. Once Web notifications are chosen for a Root, turning its
last device Off does not fall back to an external profile. The standalone CLI
has no Web Push policy; chill-agent's extensions supply it.

Letters have one presentation; users answer them with a Comment on the Goal, which
closes its open Letters. Agents use them only when a reply, choice or permission is needed. Results and progress belong in Comments and
remain silent under the Letter-only preference. Historical no-reply Letters
retain their original pending-count behavior. An unanswered Letter blocks only
the work that depends on its answer, not other agreed actions.
