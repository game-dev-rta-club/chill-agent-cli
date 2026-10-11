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
| Understand page loading, live updates and Brief history | [Web navigation](workspace/web-navigation.md) |
| Separate projects, ports and extension choices | [Project workspaces](runtime/projects.md) |
| Choose branches, commit milestones and prepare a PR | [Development workflow](development/workflow.md) |
| Change Web navigation, layout updates or focus without scroll jumps | [Scrolling guidelines](development/scrolling.md) |
| Understand the SQLite replacement under development | [SQLite workspace](runtime/sqlite.md) |
| Locate data or update an installation | [Data and runtime updates](runtime/data-and-updates.md) |
| Start Web or understand when it exits | [Server lifetime](runtime/server.md) |
| Connect feedback, pause and resume | [Feedback delivery and controls](agent/feedback-and-controls.md) |
| Read or change the current model | [Model settings](agent/model-settings.md) |
| Plan additional agent connections | [Harness connection proposal](agent/harness-connections.md) |
| Plan a return path to the current Claude conversation | [Claude conversation proposal](agent/claude-conversation.md) |
| Qualify Claude's local hook-to-CLI identity handoff | [Claude entry handshake](agent/claude-entry.md) |
| Prepare project-local hooks for the same Claude conversation | [Experimental Claude setup](agent/claude-setup.md) |
| Create a new Claude Root and read its feedback through a main hook | [Experimental Claude actions](agent/claude-actions.md) |
| Receive a reply after Claude finishes responding | [Reply waiter](agent/claude-wait.md) |
| Check whether Claude is waiting for Web replies | [Recorded Claude connection status](agent/claude-status.md) |
| Interpret Running, Done or an unknown state | [Execution state](agent/execution-state.md) |
| Host a policy or add its Web control | [Extension API](extensions.md) |

Examples use `chill` for the exact command prefix returned by setup. Before
setup, use `node bin/chill-entry.mjs` from a built checkout. Run a command with
`--help` for the arguments supported by that version.

For development and release work, see [Contributing](../CONTRIBUTING.md) and
[Releasing](../RELEASING.md). Use [Security](../SECURITY.md) for private vulnerability
reports and the [Changelog](../CHANGELOG.md) for tagged release history.
Each behavior has one home here; consumer projects
can link to it without copying the specification.

For guideline and task-entry maintenance, see [Writing development guidelines](development/guidelines.md).
