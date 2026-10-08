---
keyPoints: >-
  The reading pane owns page scrolling. Explicit actions may reveal a target;
  background updates preserve visible content. Cancel delayed moves on reader
  interaction or navigation and validate intermediate positions in browser trials.
---

# Keep the reader in control of scrolling

Read this when changing navigation, Activity, Brief rendering, conversation
folding or focus behavior. The user should never have to fight an update to keep
reading. [Web navigation](../workspace/web-navigation.md) describes the public
behavior; this page explains how to preserve it when developing the interface.

## One owner for the reading pane

Use [reading-pane.js](../../public/reading-pane.js) for programmatic changes to
the main pane. Keep the header and window fixed. Do not add `scrollIntoView`,
smooth scroll retries, bottom-follow timers or another anchoring observer for
page content. Browser scroll restoration and native scroll anchoring are disabled
for this pane so they cannot compete with explicit position correction.

| Trigger | Intended result | Mechanism |
| --- | --- | --- |
| Open or reload a plain Goal, or return to its plain route | Start at the top | `setTop(0)` |
| Open a Letter or locate an annotation / Activity | Reveal that target; tall targets start at the heading | `reveal`, after required layout is ready |
| Step through Brief history | Keep the current vertical position, within the new page's bounds | `setTop(previousTop)` |
| View an updated Brief | Reveal the Brief heading | `reveal(..., 'start')` |
| Expand earlier/later comments | First revealed comment starts at the opened edge | `align` |
| Collapse earlier comments | Keep the Conversation heading reachable | `reveal(..., 'nearest')` |
| Save a comment or Answer | Bring the saved item into view only as needed | `reveal(..., 'nearest')` |
| Receive Activity, refresh metadata, resize an iframe or render a diagram | Keep the visible message boundary in place; when reading a Brief, retain the vertical position | `preserve` around the DOM mutation |
| Replace the current Brief asynchronously | Keep the current reading position unless the reader moves | `capture` before the replacement, restore after layout |

A background update does not follow new output to the bottom. Position correction
may change `scrollTop` to offset content growing above the reader; the evidence
of stability is the visible content's viewport position, not an unchanged number.
After an explicit move, its visible destination is the preferred anchor until
the reader moves again, so late Activity cannot push a just-opened Letter away.
When the old anchor disappears or the page becomes shorter, retaining the exact
position may be impossible; use the previous offset, clamped by the browser.

## Treat delayed layout as part of the same action

In [app.js](../../public/app.js), a Letter route waits for Brief layout once.
Activity requests do not delay navigation; their later layout changes preserve
the visible target. Capture both the navigation generation and the reading pane's
interaction revision; discard the move if either changed. Wheel, touch, scrolling
keys, scrollbar dragging and a newer explicit move invalidate older work. Do not
interpret a programmatic scroll correction as fresh user intent.

Reuse the Brief on same-Goal Letter navigation and unchanged conversation nodes
on polling. Preserve position around iframe sizing and diagram replacement rather
than trying to guess their final height with a timeout. Keep drafts and selections
alive. HTML Brief coordinates must be translated into the outer viewport before
revealing an annotation.

Menus and dialogs are separate scroll regions. Preserve the Agent panel's own
position when refreshing it. Restored focus and background refocus use
`preventScroll: true`; keyboard navigation inside a menu may reveal its focused
control. Opening an Answer editor and focusing an invalid input may let the
browser reveal the field and mobile keyboard. Do not globally disable that
accessibility behavior or make it a reason to scroll the main page to the bottom.

## Verify what the reader sees

Build the Web bundle and run the relevant isolated browser trials:
`test/letter-navigation-web.mjs`, `test/brief-updates-web.mjs`,
`test/conversation-window-web.mjs` and `test/letter-conversation-web.mjs`.
Set `PLAYWRIGHT_MODULE` when Playwright is installed outside the checkout. These
trials supplement the repository's required `npm run check`; they are not native
phone testing.

Check desktop and mobile widths, a long HTML Brief, delayed iframe/delivery
responses, repeated Activity growth above the reader, same-Goal links, reload,
user interaction while loading, drafts, keyboard focus and folded history. Record
intermediate target positions as well as the final one: several jumps that return
to the right location still fail the reading experience. A new asynchronous layout
source needs a matching browser case, not a test that merely matches source text.

Agent entry: [read before changing Web scrolling](../../.agents/skills/chill-cli-web-scroll/SKILL.md).
