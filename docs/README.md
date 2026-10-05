---
keyPoints: >-
  Start with workspace concepts, then read only the storage, agent connection or
  extension contract needed for your integration. CLI help owns exact arguments.
---

# Build on the Goal workspace

chill-agent-cli gives an agent workflow a shared place for plans, results and
questions. It owns the data, Web interface and connection to the agent's chat.
The integrating application decides what work to pursue and when to continue it.

| I want to… | Read |
| --- | --- |
| Understand Goals, completion and progress | [Goal lifecycle](workspace/goals.md) |
| Publish a plan or ask a question | [Briefs and Conversation](workspace/briefs-and-conversation.md) |
| Find the next relevant Goal without reading everything | [Read in layers](workspace/reading-goals.md) |
| Locate data or update an installation | [Data and runtime updates](runtime/data-and-updates.md) |
| Start Web or understand when it exits | [Server lifetime](runtime/server.md) |
| Connect feedback, pause and resume | [Feedback delivery and controls](agent/feedback-and-controls.md) |
| Interpret Running, Done or an unknown state | [Execution state](agent/execution-state.md) |
| Host a policy or add its Web control | [Extension API](extensions.md) |

Examples use `chill` for the exact command prefix returned by setup. Before
setup, use `node bin/chill-entry.mjs` from a built checkout. Run a command with
`--help` for the arguments supported by that version.

For development and release work, see [Contributing](../CONTRIBUTING.md) and
[Releasing](../RELEASING.md). Each behavior has one home here; consumer projects
can link to it without copying the specification.
