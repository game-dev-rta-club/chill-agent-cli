---
keyPoints: >-
  Before a release that bumps the version and after a Codex update, run
  node scripts/probe-codex.mjs (every Codex behavior chill relies on, fake model,
  no cost), node scripts/probe-codex.mjs scenarios (every user-visible flow on the
  real app-server, no cost) and node scripts/probe-codex.mjs connection --run (one
  real round trip), then the five-minute Desktop checklist for what only Desktop
  can show. The probe records
  its result in docs/development/codex-verification/<version>.json and lists where
  test/fake-codex.mjs differs from the real app-server.
---

# Check chill-agent against the installed Codex

`npm run check` never starts Codex. Its tests use `test/fake-codex.mjs` and inline
stubs, which are held to Codex's protocol schema but still written by hand. Whether
the real Codex behaves the way those fakes assume is what this page's probe
answers. It has three automatic parts and a short manual checklist, and you run all
four before publishing a version.

## When to run it

- **Before a release that bumps the version.** Run the automatic parts and the manual checklist, then put the Codex
  version and the result of each in the release PR. [Releasing](../../RELEASING.md) links here. Internal builds of
  `develop` do not need it.
- **After Codex Desktop updates.** Run `node scripts/update-codex-schema.mjs` first, review the schema diff,
  then the probe. The probe fails its first check when the committed schema is not from the installed Codex.
- **After changing the Codex adapter or the fake.** That means `lib/codex-client.mjs`, `lib/agents/codex-*.mjs`,
  `lib/codex-desktop-connection.mjs` or `test/fake-codex.mjs`.

CI cannot run it, because CI has no Codex. The probe is macOS only and is not part of `npm run check`.

## Run the automatic probe

```sh
node scripts/probe-codex.mjs                    # protocol: fake model, no account, about 40 seconds
node scripts/probe-codex.mjs scenarios          # scenarios: every user-visible flow, fake model, about three minutes
node scripts/probe-codex.mjs connection --run   # connection: one real model round trip, about 40 seconds
```

All parts use the Codex that `resolveCodex()` finds, which is the Desktop bundle and not whatever `codex` is on `PATH`.
Each runs in a disposable `CODEX_HOME`, project and chill data directory, and prints one `pass` or `FAIL` line per
check. The exit code is 1 when any check fails. No part touches `~/.codex`, your Codex sessions, Desktop or the Web
on port 51790.

### Protocol part

A long-lived app-server stands in for Desktop. chill-style short calls run in separate processes through chill's own
`withCodex`, so the probe sees what chill sees: a second app-server reading a chat that the first one runs. The model is
a local HTTP server that speaks the Responses API, set as a `model_providers` entry in the disposable `config.toml`, so
turns complete at zero cost.

It checks, as named lines:

- `initialize` with `experimentalApi`, `thread/start`, and what another process can and cannot see before a chat's
  first message.
- `thread/queue/add`, `list` and `delete`: reply shapes, FIFO order, `limit` and `cursor` paging, and that an input queued
  from another process runs as a turn in the long-lived one, with its text and `[chill-agent:<id>]` marker verbatim.
- `thread/turns/list` and `thread/items/list`: newest-first and oldest-first defaults, `sortDirection`, `itemsView`,
  paging, and `startedAt` and `completedAt` in seconds against `startedAtMs` in milliseconds.
- `thread/read`: status from another process, `includeTurns`, and the rollout at `thread.path` that holds each turn's
  model and effort.
- Hooks: that `hooks/list` accepts the `.codex/hooks.json` that `installHook` writes (PostToolUse and Stop) with no errors,
  that a new hook is `untrusted` and does not run, how to trust it, and that the stdin of a trusted run has the fields
  `bin/chill-hook.mjs` reads.
- Stop hook: with feedback the chat took and said nothing about, chill's real Stop hook answers `{decision:"block",reason}`,
  Codex continues the turn and sends the reason to the model, and the next Stop carries `stop_hook_active: true` and ends.
- `verifyThread`, which `goal adopt` uses, on a used chat and on one that is not a saved chat.
- Schema: every request chill sends and every answer it gets for a method in
  `test/fixtures/codex-app-server-schema.json` is validated, so a drifted field shows up as a failing `schema:` line.

Then it replays the same requests on `test/fake-codex.mjs`, seeded with the turns the real Codex produced, and lists
where the answers differ in shape or behavior. That list is the backlog of fake fixes.

The fake answers as the real Codex answers chill, which always reads from a second process beside Desktop. The chat
reads `notLoaded`. A live turn reads `interrupted` with `completedAt` null, so chill knows a turn works only from
its tool hooks. A chat is invisible before its first message. An idle chat runs the next queued input as a turn at
once. `test/fake-codex-desktop.mjs` holds that chat, and tests change it as Desktop and its model would: start or end a
turn, read what chill sent. On `0.163.0-alpha.10.2` only optional fields the fake omits and the model count remain.

#### Trusting a hook without touching your config

Codex lists a project hook only when the project is trusted, and runs it only when its hash is trusted. The probe writes
both into the disposable home through the app-server, so no setting of yours changes:

```text
config/value/write  keyPath projects."<dir>".trust_level           value "trusted"
config/value/write  keyPath hooks.state."<hook key>".trusted_hash  value <currentHash from hooks/list>
```

A chat reads its hooks when it starts, so a chat that was already open when the hook was trusted keeps running without it.

### Scenarios part

It runs `test/harness-scenarios.test.mjs`, the user-visible flows that `npm run check` runs on the fake Codex and on
Claude Code, on the installed Codex instead. A long-lived app-server stands in for Desktop, chill's real hooks are
installed and trusted in the disposable home, and a scripted model drives each turn: it answers, calls a tool (which runs
chill's PostToolUse hook) or ends the turn (which runs chill's Stop hook). A small server at `CODEX_HOME/ipc/ipc.sock`
stands in for Desktop's IPC and passes its requests to the app-server, so Pause, Resume and a stopped chat's next
message run too. Each scenario is one `pass` or `FAIL` line.

It covers what the manual checklist's steps 5 to 10 look for on chill's side: feedback reaching an idle chat, Think,
Waiting and Send now, Pause, feedback while paused, Resume and Interrupted. The checklist still covers Desktop's own
windows and the shape of its IPC, which the stand-in only assumes.

### Connection part

One real round trip, to be run once per release. It needs a Codex login (`codex login`) and spends about 100,000 tokens,
more than 90 percent of them cached input, on one model at medium effort. The model is `SOL` at the top of
`scripts/probe-codex-connection.mjs`, currently `gpt-6.1-sol` at `medium`. That constant is the latest Sol confirmed to
work, so update it when a newer one is confirmed, or pass `--model` and `--effort` for one run.

The probe links `~/.codex/auth.json` into the disposable home read-only, never prints or copies it, removes the link
at the end, and checks that the file is byte-identical afterwards. It refuses to start when the access token expires within
an hour, because a refresh inside the probe could rotate your login. Open Codex Desktop once and rerun.

The flow, each step a named check:

1. chill creates a Goal and installs its hook in a disposable project (the data directory lives inside the project, so the
   workspace-write sandbox can write it). The probe trusts the hook as above.
2. The long-lived app-server starts a chat on the real model and answers its first message. `goal adopt` from that chat accepts it.
3. `goal feedback` saves a short, explicit message and sends it to the idle chat as one Queue message, which starts a turn.
4. The turn's first command is `pwd`. The PostToolUse hook runs and hands nothing more: the comment was already handed.
5. The model replies on the Goal with one `comment`.
6. The reply answers the Goal (no mark is left under the comment), Codex's Queue is empty, and chill reads the turn's
   output back as the Goal's Think, with the model and effort it ran on.

The token usage Codex reports for the feedback turn and for the whole chat is printed and recorded.

`--fake-model` replaces the real model with a scripted one that follows the same path, so you can rehearse the flow
at no cost. A rehearsal records nothing.

## Read the record

Each run merges its result into `docs/development/codex-verification/<codex version>.json`. Commit it with the
release PR. It holds the Codex version and, for each part, `passed`, the date, the chill commit with whether the tree had
uncommitted changes, and every check with its detail. The connection part adds the model and token usage, and the protocol part
adds `differences`. A new Codex version gets a new file, so the history of verified versions stays in Git.

`differences` entries name the requests they cover and what differs. "Only in real" means the fake omits an optional
field, which matters only if a test starts to read it. A behavior entry marks something tests cannot learn from the
fake until the fake is fixed.

## When a check fails

A failing line names the behavior and the detail shows what Codex answered. Decide which side is wrong.

- **Codex changed.** Fix chill, then update the fake and its tests so `npm run check` would have caught it. Regenerate the
  schema with `node scripts/update-codex-schema.mjs` if the shape moved.
- **The probe is wrong.** The assertion encoded a guess about Codex that the Codex never promised. Fix the probe and say what
  you learned in the commit.
- **A fake difference matters.** Fix `test/fake-codex.mjs` when the change is small and clear, as the `itemsView` default
  was, and keep `npm run check` green. Otherwise add it to the record's `differences` and open an issue.

Do not weaken a check to make it pass. A hidden failure is how the fakes drifted in the first place.

## Real Codex behavior the probe pins

These were observed on `0.163.0-alpha.10.2` and are asserted on every run.

| Behavior | Where chill depends on it |
| --- | --- |
| A queued input drains into a turn when the chat is idle, even when it was queued from another process | feedback delivery |
| `thread/turns/list` without `itemsView` returns `summary`: the first user message and the last agent message | callers always pass `itemsView` |
| Another process reports a live turn as `interrupted` with `completedAt` null | Progress closes a turn only on `completedAt` |
| A chat is invisible to other processes until its first message, and `thread/turns/list` fails with "not materialized" | `goal adopt` needs a chat that has been used |
| `thread/read` with `includeTurns` lists turns oldest first, while `thread/turns/list` lists newest first | `reconcile` and `workReader` |
| A hook runs only in chats started after it was trusted | the manual checklist starts a new chat |
| A Stop hook's `{decision:"block",reason}` continues the turn with the reason as model input; the run reports `blocked`, and the continued turn's next Stop has `stop_hook_active: true` | the quiet-stop hold |
| A chat whose last turn was stopped does not run its queue; only a started turn goes on (scenarios part) | a stopped chat's next feedback and Resume start a turn through Desktop's IPC |
| Desktop's app-server picks up an input queued from another process a few seconds later (scenarios part) | none; a comment to an idle chat shows Sent before the turn starts |

## Check what only Desktop can show

The probe stands in for Desktop with a second app-server, so it cannot see Desktop's own windows or its IPC socket. These
steps do, and take about five minutes. Run them on the release candidate with the installed Desktop, and write the Desktop
version and any step that did not match in the release PR. The expected results come from the product's design, so a
mismatch is a finding, not a typo in the list.

Prepare once:

1. In a scratch folder, run `git init`. From the release candidate checkout, run
   `node bin/chill-entry.mjs setup prepare --project <scratch folder>` and keep the `command` it prints. The steps below
   write it as `chill`.
2. Open the scratch folder in Codex Desktop. In `/hooks`, review and trust both chill-agent hooks, PostToolUse
   ("Check Web feedback") and Stop ("Check the user has heard back"). Start a new chat,
   because a chat that was open before the hook was trusted does not run it.
3. In that chat, send `Run chill goal create --title "Desktop check"`. The new Root belongs to that chat.
4. Run `chill server start --local`. Open the printed URL and open Goal 1.

Check:

5. **Feedback reaches an idle chat.** In Goal 1, send "Reply with the word ok." Expected: within a few seconds the Desktop
   chat shows a new user message that begins `=== chill-agent · User Feedback ===` and the agent starts. The comment's
   mark goes Sent, the Goal shows Running, and when the agent's reply appears in Conversation the mark
   goes away.
6. **Think.** Below Goal 1's conversation, the agent shows Running with Think open. Expected: Think shows the model and
   reasoning level the turn ran on, which match Desktop, and the agent's messages as they come.
7. **Waiting and Send now.** In Desktop, send "Run `sleep 10` in five separate commands, then reply done." While it runs, send
   "Reply with the word sent." from Web. Expected: the feedback shows Waiting with a Send now button, and the Queue
   in the Agent panel lists it. Press Send now. After the agent's next command finishes, Desktop shows the hook running with its
   status text "chill-agent: Check Web feedback", the agent reads the feedback, and its mark moves to Sent. The Queue
   entry disappears; the agent's reply clears the mark.
8. **Pause.** In Desktop, send the same five-command request again. While it runs, open the Agent panel (the header
   button labeled Agent). Expected: Activity shows Running with a Pause button. Press Pause. The Desktop turn stops
   within a few seconds and the panel shows Paused with a Resume button. Pressing Desktop's own stop instead shows
   Interrupted, not Paused.
9. **Feedback while paused.** In Web, send "Reply with the word held." Expected: the feedback shows Paused, and
   Desktop's chat and the Agent panel's Queue stay empty.
10. **Resume.** Press Resume. Expected: the panel returns to Running, Desktop receives the held message, the agent
    answers it, and the mark goes away.
11. **Settings save.** In the Agent panel, change Reasoning to another level. Expected: the panel shows Saving, then the new
    level, and Desktop's composer shows the same level after you reopen the chat. Change it back.
12. Stop the server with `chill server stop` and delete the scratch folder.

A step that fails here and passes in the probe points at Desktop-only code, which is `lib/desktop-settings.mjs` (the IPC
socket behind Pause, Resume and settings save) or the Web.
