---
keyPoints: >-
  Run this checkout, uncommitted changes included, in one project's own Web in
  seconds: npm run try-local -- --project <dir>, then press the Web's update
  button. No GitHub, CI or project file changes; --reset returns to the recorded
  version file. Publish through PRs
  only when another project or machine needs the change.
---

# Try a local change in a project's Web

Use this while dogfooding: change the CLI, see it in a project's Web, adjust,
repeat. It does not share anything. When another project, another machine or
another person needs the change, publish it through a PR and a version file
([use a development version](use-development-version.md)), batching what was
already tried.

```sh
npm run try-local -- --project /path/to/project
```

1. `npm pack` packs this checkout, uncommitted changes included, into the
   project's data folder (`runtime/local`). Identical content gives the same
   package, so an unchanged build is reused.
2. Only that project's data points at the package. The project's own
   `chill-agent.json` and its Git checkout stay unchanged.
3. The project's Web shows its update button. It switches when someone presses
   the button, never in the middle of running work. `--restart` restarts the
   Web immediately instead. Each run appends its times to
   `runtime/local/timings.jsonl`.

The three newest packages are kept. The project must have run setup with a
version file first.

```sh
npm run try-local -- --project /path/to/project --reset
```

`--reset` returns the project to the version file its setup recorded; press the
update button if the Web shows one. Running setup again in the project also returns it.

The package skips CI, so a change that only breaks Windows or a clean install
appears when it is published. Run the relevant tests before trying, and the
full check before publishing.

Implementation: [try-local](../../scripts/try-local.mjs).
