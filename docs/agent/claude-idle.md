---
keyPoints: >-
  An opt-in finite resume/Stop watcher can wake the same native Claude process for saved
  Web feedback. One checkpoint permits one offer; holds and uncertain deliveries
  are preserved. Stream-mode and interactive prior-context qualification pass;
  explicit setup supports finite watches up to 24 hours. A twelve-hour configuration
  passes an eleven-minute native check; overnight uptime remains unverified.
  Optional continuation uses a separately qualified connection extension.
---

# Receive Web replies while Claude is waiting

The experimental `connection claude-watch` waits for new saved feedback after a
verified main conversation stops, or when the same conversation is resumed with
`claude --resume`. With the opt-in hooks installed before launch, resume needs no
initial message to start checking for saved replies. It uses Claude's native
[`asyncRewake` hook](https://code.claude.com/docs/en/hooks#command-hook-fields),
which can wake the still-open process. It does not launch another conversation,
send another user prompt, or change native tool permissions.

This is a bounded development route, not a permanent listener. The default watch
lasts five minutes; `--timeout-ms` accepts one second to twenty-four hours. Expiration
does not renew it or wake the Agent with no work. A later verified main action
and Stop can establish a new watch. The explicit [Claude setup](claude-setup.md) installs it only with
`--idle-watch-ms`; default Codex setup does not. The
Agent menu shows [recorded watcher checks and expiry](claude-status.md), with a
route back to the original conversation. It does not advertise general
idle-delivery support.

## Set a window for time away

For a morning/evening rhythm, explicitly choose twelve hours at setup:

```sh
chill setup prepare --harness claude-code --project /absolute/project --idle-watch-ms 43200000
```

The installer sets **both** the chill deadline and Claude's native hook timeout
(the latter includes five seconds for completion). Changing only the chill
argument can leave Claude's default ten-minute hook timeout in force. The
[official hook reference](https://code.claude.com/docs/en/hooks#common-fields)
allows a custom timeout and enforces it for `asyncRewake` hooks.

Keep the original Claude process and computer running during the window. Closing
Claude, sleeping past the deadline or losing the watcher can interrupt receipt;
this is not an offline delivery service. Replies stay saved for the original
conversation's inbox. The [Agent menu](claude-status.md) shows a recorded check
and expiration, not a promise that the process will remain available.

Waiting itself invokes no model. The watcher reuses the event history until its
storage directory changes; conversation ownership, manual holds and delivery
receipts are checked freshly. A real reply may wake the Agent once. Expiration
alone does not wake it or establish another watch. Review [native tool
permissions](claude-setup.md#allow-the-operations-you-intend-to-delegate) before
leaving: a longer watch cannot approve the subsequent tools.

## Configure both sides of Stop

In an isolated session, configure `connection claude-hook` for `SessionStart`,
`UserPromptSubmit`, all `PostToolUse`, `Stop` and `SessionEnd`. Add a separate
`Stop` command calling `connection claude-watch` with `asyncRewake: true`.
Set the native hook timeout longer than the selected watch duration, including
startup and cleanup. Use the same launcher and chill data directory for all hooks.
Read their installed help for arguments; the [native probe](../../scripts/probe-claude-idle.mjs)
contains a complete temporary configuration.

The synchronous Stop hook converts the verified prompt into a checkpoint and
disarms busy tool delivery. Its asynchronous sibling may start first, so the
watcher allows a short wait for that checkpoint. Only one watcher can own it;
a duplicate or expired watcher cannot reserve another turn for the same Stop.
A separate `SessionStart` hook with matcher `resume` also calls `claude-watch`
with `asyncRewake: true`. The synchronous identity hook records a resume
checkpoint only for an existing context. Sibling hooks match the native parent
process and event payload before using it. Fresh startup, clear and fork cannot
inherit that checkpoint. A prompt, action or exit revokes it just like a Stop
watch. Resume does not consume a model turn until eligible feedback arrives.

The watcher scans all Goals belonging to the connection. It preserves manual
holds, other contexts, terminal receipts and already uncertain offers. Before
emitting feedback, it records an unconfirmed offer with the original event IDs.
It then exits with code 2 and writes the feedback to stderr for native delivery.
The Agent still has to [record a receipt](claude-actions.md). A successful process
exit or transport write is not a receipt.

A new user prompt, session generation, context, confirmed action or SessionEnd
invalidates the old watch. The CLI creates no detached background process.
If hook output is lost, explicit inbox recovery retains the same offer ID;
neither another watcher nor a busy hook automatically reoffers that input.

## Reproduce the native qualification

```sh
node scripts/probe-claude-idle.mjs --run --auth-settings /absolute/path/to/native-settings.json
```

This opt-in probe uses one disposable native process with stream input, a $0.75
budget and, by default, a 126.2-second deadline. It writes one initial user
prompt, waits for the completed response, and only then adds synthetic Web feedback from a separate
producer. The idle hook wakes the same process; the Agent must remember its
initial token, read the new feedback token and complete its receipt. The probe
closes its input, cleans up its process group and deletes temporary files.
For a sustained check, add `--feedback-delay-ms 660000 --watch-ms 43200000`.
That configures twelve hours but measures eleven minutes of real waiting; its
overall deadline is thirteen minutes. The final cleanup watch is shortened to
one second after the tested wake, so ending the fixture does not wait another
twelve hours. Clock-driven tests cover late replies, manual holds and expiration
at twelve and twenty-four hours. They do not establish overnight native uptime.

Native credentials are used only in memory as described in the
[main-hook probe](claude-actions.md#verify-the-boundary-before-enabling-a-real-session).

On 2026-10-06, Claude Code 2.1.289 passed this roundtrip with a twelve-hour
configuration after 660.002 seconds of real waiting. All sixteen checks passed:
there was one wake, the same native session retained its initial context, the
reply receipt completed, and normal shutdown recorded SessionEnd. This checks
operation beyond the native default ten-minute timeout; it is not a twelve-hour
wall-clock run. Native hooks showed a new prompt ID in that same session after
the wake, without another user input. Local
tests cover duplicate ownership, expiry, prompt/exit/generation invalidation,
manual holds, separate connections and recovery without automatic reoffering.

## Keep earlier context in an interactive terminal

```sh
node scripts/probe-claude-interactive.mjs --run --report /absolute/path/to/report.json --auth-settings /absolute/path/to/native-settings.json
```

The interactive probe starts with a memory-only conversation. After `READY`,
submit `Start the probe now` to create the Root in that same conversation. Its
producer saves feedback only after the Agent has finished responding. The watcher
wakes the existing process; the Agent returns the earlier memory and feedback
tokens and completes the receipt. After `COMPLETE`, submit `/exit`.

Claude Code 2.1.289 passed this roundtrip on 2026-10-06. Its native onboarding,
API-key choice and temporary-folder trust prompts were completed in the terminal.
Hooks were configured at launch, before the earlier conversation; this does not
qualify hot-installing them into an already running user session. Normal settings
and production chill data were untouched.

The probe allows five minutes and removes its temporary data after native exit.
Unlike the print-mode probe, it has **no dollar budget**: native interactive mode
does not provide that flag. It uses a small fixed conversation and retains native
permission handling. The report contains selected hook facts and checks, not the
API credential or full conversation.

This still does not establish an always-available return path. Overnight
wall-clock qualification and native interruption remain open;
[first-use exit-and-resume setup](claude-setup.md) has separate qualification.
[Recorded status](claude-status.md) can explain a missing reply without claiming
live execution state. [Channels availability](claude-channels.md) was
checked separately and is not currently established in this environment.
Optional [connection hooks](../extensions/connection-hooks.md) can claim a Stop
for continuation; that cancels the old watcher. The continuation policy must
abstain if this watcher has already reserved pending input.
