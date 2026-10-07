---
keyPoints: >-
  A disposable native interactive Channels probe reaches MCP initialization but
  Claude reports Channels unavailable. No channel message was sent and no return
  path is established. Keep general idle delivery unavailable; do not retry an
  uncertain offer through a hook or change native policy to pass qualification.
---

# Check whether Claude can receive a channel event

**Not qualified in the current environment.** On 2026-10-06, Claude Code 2.1.289
displayed `Channels are not currently available` in a disposable interactive
terminal. The local test MCP server initialized successfully using protocol
`2025-11-25`, but no development-channel consent appeared. The probe was exited
before Root creation or feedback injection. It sent zero channel notifications.

This narrows the result: an initialized MCP server does not establish a channel
return path. The notice did not identify its cause, so do not attribute it to the
account, organization policy or a version defect without further evidence.
The separate [finite Stop watcher](claude-idle.md) passed native interactive
qualification and remains an opt-in, bounded development route.

## Reproduce only in a disposable terminal

```sh
node scripts/probe-claude-interactive.mjs --run --channel --report /absolute/path/to/report.json --auth-settings /absolute/path/to/native-settings.json
```

The probe configures one local, one-way MCP fixture and requests native
development-channel consent. It installs no user settings, opens no network
listener, offers no MCP tools or permission relay, and does not enable a Stop
watcher as a fallback. The fixture implements only the MCP lifecycle needed to
qualify the transport; it is not a production adapter or session-discovery design.

If native channel activation is available, submit `Start the probe now` after
`READY`. The intended test creates one Root, injects two saved feedback events
on separate idle turns, then checks both native receipts, prior-context retention
and one channel process. Exit after two `COMPLETE` responses. Those checks have
**not** passed yet. If native activation is unavailable, exit without claiming
feedback or changing provider policy. The test has the same time, cost and
cleanup limits as the interactive watcher probe.

## Keep installation and receipt facts separate

The [official channel reference](https://code.claude.com/docs/en/channels-reference)
requires explicit session opt-in, and a transport write has no delivery
acknowledgement. Development consent does not override organization policy.
The [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
separately establishes protocol compatibility; that is the part this environment
did pass.

Before shipping a channel adapter, qualify activation, main-conversation binding,
receipt handling, reconnection, holds and shutdown together. An uncertain offer
must retain its ID without automatically switching to another transport. Do not
mark permanent idle delivery supported based on this fixture or add an implicit
new-conversation fallback. Native Auto mode and explicit project setup are independent
unfinished parts of the [connection design](claude-conversation.md).
