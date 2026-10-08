---
keyPoints: >-
  Web loads a compact workspace snapshot, opens known Goals from memory and refreshes
  in the background. Tabs count unanswered Letters under their own Root, including
  hidden tabs. Goal links start at the top; Letter links locate the message while
  background updates keep visible content in place. Earlier Briefs load on demand.
---

# Move between Goals without waiting for a poll

The first Web visit loads the tree, latest Briefs and Conversation through
`GET /api/goals?view=web`. Moving to a known Goal renders that in-memory snapshot
immediately, then checks for changes in the background. Polling, focus and route
changes share an in-flight request rather than downloading the same data twice.
Hidden tabs pause the full workspace refresh. They continue a small Letter-count
request every 15 seconds, subject to the browser's background timer throttling.

The header keeps Agent and Letters beside each other. Letters opens the unanswered
list for the current Root and its descendants; on the Goals index it includes all
Roots. The envelope shows a muted zero when empty and a highlighted count when
there are Letters. Goals navigation lives inside More, even without extensions.

The browser tab shows the current Root's title and unanswered Letter count,
including all descendants: `(2) Root title · chill`. Opening a child or an older
Brief keeps that Root's count. Other Roots do not contribute. Answers and explicit
receipts remove a Letter; ordinary comments do not. When there are none, the
count prefix disappears. A failed count request keeps the last known value;
returning to the tab refreshes the workspace immediately.

The snapshot includes earlier Briefs' version numbers and dates, not their full
bodies. Opening one loads `GET /api/goals/:id/briefs/:version` and keeps it in memory
for that visit. HTML Briefs still load in their isolated document frames. The
unqualified `/api/goals` endpoint retains its full response for existing clients.

Drafts use the existing browser storage and survive route changes. Background
updates preserve the current reading position and offer a new Brief when one is
published. A failed refresh leaves the last loaded content available; it does not
claim that content is current. A first visit and an uncached earlier Brief still
need a connection. No workspace data is made available offline by this cache.

Opening or reloading a plain Goal starts at the top. A Letter link waits for its
Brief layout, then brings the message into view; a tall Letter starts
at its heading. Moving between Letters in the same Goal reuses the Brief. If the
reader scrolls while a link is loading, that interaction takes priority over the
pending jump. Background Activity, Brief sizing and diagram rendering preserve
the visible conversation boundary, or the current position when reading the Brief.
Only the reading pane scrolls; the header stays fixed.

JSON snapshots and static assets support gzip. The main JavaScript is bundled;
the larger Mermaid renderer loads only when a diagram needs it. Static assets use
private revalidation with ETags, while page HTML and workspace data stay uncached
by HTTP. A server rendering cache holds only generated markup, not execution or
Letter state, so current state is read again on each snapshot.

Implementation: [browser navigation](../../public/app.js),
[snapshot projection](../../lib/web-snapshot.mjs), [HTTP routes](../../server.mjs).
For changes to positioning or focus, follow the [scrolling guidelines](../development/scrolling.md).
