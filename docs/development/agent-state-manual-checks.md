# Manual checks for agent state in the real apps

Tests and probes cover the rules ([agent rules](../../lib/agent-rules.mjs)) against the fake
Codex, recorded Claude Code samples and print-mode Claude. What only the apps with a
screen can show is checked here, by the user and the agent together, once a build
with the Goal #53 rebuild is running. [Past bugs](agent-state-bugs.md) lists what each
check guards against. Codex Desktop has its own list in
[Codex verification](codex-verification.md#check-what-only-desktop-can-show).

## Before the checks

1. Merge the change and update the runtime. The user restarts chill Web; the agent
   does not.
2. With the user's agreement, install the Claude hooks again in the project:

   ```bash
   chill setup prepare --harness claude-code --project <project folder>
   ```

   Expected: the project's `.claude/settings.local.json` has chill's hook on
   `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`,
   `PostToolUse`, `Stop`, `StopFailure` and `SessionEnd`.
3. Open a Claude Desktop conversation in that project that owns a Root Goal, and
   open the Goal in the Web next to it.

## Claude Desktop

Each check names what to do, then what the Web must show. "Agent" is the agent
button in the header; "the Goal's activity" is the block after the Goal's conversation.

1. **Running starts and ends with the work.** Send a prompt that takes a minute
   (for example, run `sleep 20` three times). Expected: the Agent shows Running
   within a few seconds; when the response ends it shows Idle.
2. **A local command is not work.** With the conversation idle, type
   `/reload-skills`, then `/reload-plugins`. Expected: the Agent stays Idle. Then
   post a Web comment on the Goal. Expected: it shows Saved, then Sent, never
   Waiting, and the conversation wakes and answers it. (Bug 33: earlier this
   showed Running for up to ten minutes and held the comment as Waiting.)
3. **Esc is Interrupted.** Post a Web comment that asks for a slow task. While
   Claude works on it, press Esc. Expected: within a few seconds the Goal's
   activity, the comment's mark and the Goal list show Interrupted, not Paused.
   Then type a new prompt. Expected: Running again. If Interrupted does not
   appear, the transcript did not record the interruption at once; report the
   time it took.
4. **Pause from the Web.** While Claude works on a Web comment, press Pause in the
   Goal's activity. Expected: Paused; Claude's next tool call is refused. Post
   another comment. Expected: it shows Paused and does not reach Claude. Press
   Resume. Expected: Claude wakes once and receives the held comment.
5. **Waiting and Send now.** While Claude works, post a comment. Expected:
   Waiting with Send now. Leave it: it reaches Claude when the response ends.
   Repeat and press Send now: it reaches Claude after its next tool call.
6. **A reply clears the marks.** When Claude replies on the Goal, the marks under
   the comments it answered disappear at once and the Goal shows Replied, even
   while Claude keeps working.
7. **Background work keeps it Running.** Ask Claude to start a background
   subagent and reply. Expected: the Agent and the Goal stay Running until the
   subagent ends; a background dev server alone does not keep them Running.
8. **The stop is held once.** Post a comment and let Claude end without replying
   on the Goal (for example, ask it to only think). Expected: Claude is asked
   once to tell the user where things stand, and it replies or posts a progress
   comment.
9. **An idle conversation survives.** Leave the conversation idle with its reply
   waiter task for an hour or more, then post a comment. Expected: it wakes and
   answers without opening the conversation. (Bug 27: Desktop evicted idle
   conversations with their watcher.)
10. **Think.** While Claude works on a comment, open Think in the Goal's
    activity. Expected: Claude's public text appears as it writes, with its
    model.

## MessageDisplay in Claude Desktop

Think now reads the public text Claude writes to its transcript since the work
started. Claude Code also has a `MessageDisplay` hook that reports each line it
shows; if Claude Desktop delivers it, Think could use it instead of the transcript.
Check it in a disposable project, never in the user's own conversation:

1. In a scratch folder, add a project hook for `MessageDisplay` whose command
   appends its stdin to a file in that folder.
2. Open the folder in Claude Desktop and send a short prompt.
3. Expected if supported: the file has one entry per displayed message, with the
   text. Record the Claude Code version and the result in Goal #53. If the file
   stays empty, Think keeps reading the transcript.

## Print-mode probe

`node scripts/probe-claude-roundtrip.mjs --run` runs one Web round trip in a
disposable print-mode Claude (create a Root, take the feedback from the inbox,
reply on the Goal). It needs a Claude login; see its `--help`.
