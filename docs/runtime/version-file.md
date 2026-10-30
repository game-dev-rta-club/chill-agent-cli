---
keyPoints: >-
  An application selects this CLI with a version file, {"package": "<npm spec>"},
  and passes it to setup prepare --version-file. Setup records it; Web startup
  switches automatically and the update button switches a running Web when the
  file names another package. npm handles release archives and git commits alike.
---

# Select the CLI with a version file

An application such as the chill-agent skill does not bundle the CLI. It keeps
one small file, conventionally `chill-agent.json`, that names the CLI to use:

```json
{ "package": "https://github.com/game-dev-rta-club/chill-agent-cli/releases/download/v0.5.0/game-dev-rta-club-chill-agent-cli-0.5.0.tgz" }
```

The value is any npm package spec. A release archive installs prebuilt files.
A pushed commit such as `github:game-dev-rta-club/chill-agent-cli#<SHA>` makes
npm build the package through its `prepare` script. The CLI never interprets
the spec, so it does not know or care how it was installed.

## The contract with an application

An application relies on exactly two things:

1. It runs `npx -y <package> setup prepare … --version-file <absolute chill-agent.json>`.
   Older applications also pass `--agent-guide`; setup accepts and ignores it.
2. The file contains only the `package` field above.

Earlier skills named the file `cli.json`. A project set up with one keeps that
path in its record; when the file is gone and `chill-agent.json` sits beside it,
the CLI reads that instead, so reinstalling the skill needs no new setup.

Setup prepares the runtime as usual and records the version file's location
and the package each prepared snapshot came from. When a
version file was given, its result names `session start` as the next command.
Running setup again without the option, as `session start` does, keeps them.

## When the selected package changes

The CLI compares the package recorded for the running snapshot with the file's
current value. It compares the strings only and downloads nothing to decide.

- **Starting Web** (`server start` or `restart`): a different package is
  acquired with npm, prepared and started in place of the current runtime. If
  acquisition fails, Web starts with the current version and logs why.
- **Web already open**: the update icon appears. Confirming it acquires the
  package, prepares it and restarts Web at the same URL, with the
  [update safeguards](data-and-updates.md#update-from-web).

Acquired packages live under `runtime/acquired/` and prepared snapshots under
`runtime/packages/` in the data directory. Old versions are kept.

Implementation: [version source](../../lib/version-source.mjs),
[update provider](../../lib/runtime-update-provider.mjs).
