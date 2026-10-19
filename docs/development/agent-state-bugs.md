# Past agent-state bugs and what now prevents them

Goal #53 rebuilt how chill knows what an agent is doing, hands it comments and
shows replies ([agent rules](../../lib/agent-rules.mjs), [hand-off](../../lib/hand-off.mjs)).
This table maps each of the 33 bugs recorded in this area before the rebuild
(PRs #6 to #124 and Goal #53's own findings) to the test that now fails if it
returns, or to the reason it cannot return: the mechanism it lived in is gone.

Scenarios in [harness-scenarios](../../test/harness-scenarios.test.mjs) run against
both the fake Codex and a Claude Code conversation, so each one covers both harnesses.

| # | Bug | Now | Evidence |
| --- | --- | --- | --- |
| 1 | Running vanished or showed twice: several status sources refreshed out of order | One view per agent (`agentView`) feeds the icon, the Goal list, the Goal's activity and the comment marks | Scenarios "the Goal shows Running and Think while the agent works…", "the Agent menu reads the agent's name, model and status" |
| 2 | A receipt from a direct CLI call made an extra Running and Think | Mechanism gone: no receipts. Running comes only from the start and end of work | `agent-rules` "an agent runs only between the start and the end of its work…" |
| 3 | A Done Goal with a new comment still looked Done | Whether a Goal awaits a reply is tracked apart from its stored state, and shown under each comment; Running takes priority over stored Done | `goal-execution` "Done stays stored while queued and running feedback takes display priority"; `agent-rules` "a Goal awaits a reply while the user spoke last in it…" |
| 4 | Claude took feedback but answered only in its chat | Every hand-off says the user reads only the Web and gives the reply command; a stop with no reply is held once | `codex-work` "an idle chat is sent waiting comments as one message…"; scenario "a stop with nothing running and nothing said…" |
| 5 | An idle Claude conversation never woke for Web replies | The reply waiter or the watcher hook wakes it and hands the comments | Scenario "feedback saved while the agent is idle reaches it…"; `claude-wait` "the watcher hook hands saved feedback over and wakes the model with it". Desktop eviction is a manual check |
| 6 | Feedback went to an old session after Desktop continued in a new one | The hand-off cursor belongs to the Root; a new owner receives what the old one was never handed | `agent-rules` "a conversation that takes over a Root receives what its earlier owner was never handed"; `codex-work` "a reassigned Root keeps its cursor…" |
| 7 | No Auto mode switch for Claude | One switch for both harnesses | `claude-continuation` "the Web switch turns Auto mode on and off…" |
| 8 | Claude Goals showed unlinked with no Running | Running comes from Claude's own hooks, not from reading the transcript | `claude-agent-work` "work runs from the first hook until a Stop that nothing continues"; every scenario on Claude |
| 9 | "Delivery unconfirmed": the agent's command cut the marker line | Mechanism gone: no markers and no unconfirmed state | `claude-actions` "the connection CLI acts at once and prints its result; piping the output changes nothing" |
| 10 | Think, Goal Running and the Activity link were missing for Claude | Shared view and display; nothing in the Web branches on the harness | Scenario "the Goal shows Running and Think while the agent works…" |
| 11 | The waiter vanished after compaction | A waiter per context; resume and compact keep it; a stale one is replaced | `claude-wait` "resume and compact keep a running waiter…", "one waiter per context: a second exits, a stale one is replaced" |
| 12 | Claude's Pause and Resume answered "Action unconfirmed" (it read a Codex turn ID) | One Pause and Resume through the agent's own `control` | Scenario "Pause holds new feedback and Resume releases it…"; `claude-actions` "Pause on a Claude Goal holds the conversation's comments until Resume" |
| 13 | Claude left answered Letters open | Both harnesses list open Letters with their close command | `claude-wait` "Claude feedback lists open Letters…"; `codex-work` "an idle chat is sent waiting comments as one message…" |
| 14 | Two markers in one Bash output dropped both | Mechanism gone: no markers | Covered by the reason in #9 |
| 15 | A failed confirmation was silent to the agent | Mechanism gone: commands act at once and print their result; nothing waits for a confirmation | `claude-actions` "connection extension actions run at once in the calling conversation" |
| 16 | Follow-ups were picked up late | Feedback saved while the agent works is Waiting and handed at its end; Send now hands it at the next tool | Scenarios "feedback saved while the agent responds shows Waiting…", "Send now delivers feedback that waits…" |
| 17 | Total stall: Auto mode waited on a `working` receipt left open since the day before | Mechanism gone: no receipts. Auto mode waits only for comments not handed yet and names Goals awaiting a reply | `claude-continuation` "Web input during an Auto mode run waits for its stop…", "a handed Goal still awaiting a reply is named by the request…" |
| 18 | Idle for 50 minutes while CI ran | The stop hold asks for a progress comment that says what it waits for and when; a scheduled check wakes the agent | Scenario "a stop with nothing running and nothing said…"; `claude-wait` "a scheduled check wakes the conversation through its waiter when it is due, once" |
| 19 | Follow-ups showed "Unconfirmed", then got four separate replies | Mechanism gone: no per-comment state. One reply answers the Goal | `claude-actions` "one reply answers the Goal, whichever of its comments it answers"; `agent-rules` "a Goal awaits a reply… whichever comment the reply answers" |
| 20 | The tool hook and the waiter both delivered | One cursor per Root, moved under one lock: each comment is handed once | `agent-rules` "the cursor hands each comment once…"; `codex-work` "…Send now hands them at the next tool hook, once" (parallel hooks); scenario "a comment reaches the agent once…" |
| 21 | A consumed Resume request could come back | Resume wakes once | `claude-wait` "a Web pause holds feedback, refuses tool calls and survives compact; Resume wakes once" |
| 22 | The watcher of a killed conversation stayed alive for hours | The watcher ends with its Claude Code process and claims nothing | `claude-wait` "a watcher whose Claude Code process ended leaves feedback unclaimed" |
| 23 | A reply was silently lost behind `| tail -1` | Mechanism gone: no markers; commands act at once | `claude-actions` "…piping the output changes nothing" |
| 24 | The hook failed on large inputs (64 KB) and delivered nothing | Mechanism gone: no input size limit | `claude-actions` "…piping the output changes nothing" (reads a 2 MB tool result) |
| 25 | Codex dropped feedback beyond ten comments | No count limit: every waiting comment goes in one message | `codex-work` "a dozen waiting comments go to an idle chat in one message, none dropped" |
| 26 | Auto mode on but never continued: an open attempt blocked every Stop | The next Stop ends an attempt left without a result | `claude-continuation` "a request left without a result ends at the next Stop…" |
| 27 | Claude Desktop evicted a waiting conversation with its watcher | In Desktop the agent runs the waiter as a task | `claude-wait` "in Claude Desktop the agent runs the waiter as a task…". Eviction itself is a manual check |
| 28 | Done while background subagents worked | Background work is counted from the Stop input, one count for the display and the stop hold; shells are not counted | `claude-agent-work` "background agents count; shells such as a dev server or chill's own waiter do not"; `claude-actions` "a Claude reply that leaves a subagent working answers the Goal, which stays Running until the subagent ends" |
| 29 | Auto mode output was empty in every run (the Stop request came before the Stop summary) | Think is the public text written since the work started, by the start time the hooks recorded | `claude-transcript` "the transcript gives the model and the public text written since the work started" |
| 30 | A failed receipt showed Done on Codex and Needs attention on Claude | Mechanism gone: no receipts, so no agent-reported state | Covered by the reason in #2 |
| 31 | The agent was silent for 40 minutes; the user asked whether it was running | One stop-hold rule over chill's own records, for both harnesses | `agent-rules` "a stop is held once while a handed Goal awaits a reply and nothing keeps running"; scenario "a stop with nothing running and nothing said…" |
| 32 | Per-comment Running was lost when the inbox output was piped (IDs searched in the transcript) | Mechanism gone: no `offerId`; the Goals of the work come from what chill handed | Scenario "the Goal shows Running and Think…"; `claude-actions` "…piping the output changes nothing" |
| 33 | The agent showed Running after `/reload-skills` (any transcript write opened a turn) | Running comes only from hooks; a local command runs none, so comments saved after it are handed at once | Scenario "a command the user runs in the agent's own app, such as /reload-skills, does not make it Running" |

Bugs 5, 27 and 33 also depend on how the real Claude app behaves, which a test
cannot settle; [the manual checks](agent-state-manual-checks.md) cover them.
