---
keyPoints: >-
  Each browser has two switches per Root: Letters and Replies. The first switch On
  sends one setup confirmation; both Off stops that device and leaves other devices
  unchanged. Changing the public URL retires old registrations.
---

# Hear when your attention matters

Open a Goal and choose **More → Notifications**. The panel has two switches:

- **Letters**: questions that need your answer. A Claude conversation that owns
  a Goal asks every question as a Letter, never in its own app.
- **Replies**: other replies from the agent, such as results and Claude
  conversation replies.

Turn on either one and allow the browser's permission request. A confirmation
arrives a few seconds later. Tap it to return to the Goal. This browser then
receives what you switched on for that project (the Root Goal and its children).
Turning both switches Off stops notifications on this device.

Each device has its own switches. Turn them Off on your phone to stop phone alerts;
your computer's choice stays unchanged. A new browser or project starts with both
Off, and the switches stay visible so you can see what each would send.

For your phone, open **More → Public link** on your computer and scan its QR. On iPhone,
add the page to your Home Screen and open that app first. Then turn on a switch in the
phone's Notifications panel. Permission belongs to that browser and URL. If previously
blocked, change the browser's site settings before trying again.

## Control interruptions

Keep only **Letters** on to hear only when a reply, choice or permission is
needed. A notified reply also counts in the tab title and appears under
Replies in the header Letters menu until you open its Goal or choose **Mark all
read**; see [Web navigation](../workspace/web-navigation.md). Opening a notification shows that reply in its Conversation. A device set
up before these switches keeps its earlier choice: every reply turns both on, and
Letters only turns on Letters.

Web notices new replies by itself, for Codex and Claude alike, so no Agent command
is needed. An Agent's `settings notice` request for the same reply sends nothing
more: each reply reaches a device at most once. Your own comments, progress,
Deliverable saves and AutoContinue checks do not send Web notifications. A reply saved
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

The [Public link panel](public-link.md) opens or closes phone access. Notifications Off
does not close it. While the public link is Off, alerts may arrive but their
Goal links cannot open remotely. A different temporary URL needs a fresh phone
registration. Once a new public URL is confirmed, registrations for the previous
URL stop receiving notifications. This avoids sending to both an old and a new
subscription on the same phone. Other devices registered at the current URL
remain independent; the app does not guess which physical device a browser is.
A fixed URL avoids that change.

Registering the same push subscription again keeps a single recipient, even if
site storage was reset. Preparing the same reply more than once also sends it
only once per subscription. A single phone using separate browser profiles can
still have separate registrations; turn Off in any profile you do not want.

Existing host-tool notification profiles remain available through the CLI and
message-setup skill. Once Web notifications are chosen for a Root, turning its
last device Off does not fall back to an external profile. The standalone CLI
has no Web Push policy; chill-agent's extensions supply it.

Letters have one presentation; users answer them with a Comment. Use them only when a reply,
choice or permission is needed. Results and progress belong in Comments and
remain silent under the Letter-only preference. Historical no-reply Letters
retain their original pending-count behavior. An unanswered Letter blocks only
the work that depends on its answer, not other agreed actions.
