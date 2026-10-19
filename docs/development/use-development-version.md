---
keyPoints: >-
  Try an unreleased CLI commit in another project and share it with that team:
  push the commit, run npm run use-in -- --project <dir>, commit the project's
  cli.json. Starting Web or the update button then switches. No release, tag or
  version change; npm builds the commit on first install.
---

# Use a development version in another project

Use this to run a CLI commit in a real project, such as one that installs the
chill-agent skill, before any release. The whole team of that project gets the
same commit once its `cli.json` is committed. See the
[version file contract](../runtime/version-file.md) for how the switch works.

1. Commit and push the CLI change. A topic branch is enough; the commit must be
   on the remote so other machines can fetch it.
2. From this checkout, point the project at it:

   ```sh
   npm run use-in -- --project /path/to/project
   ```

   It refuses an unpushed commit. It writes
   `{"package": "github:game-dev-rta-club/chill-agent-cli#<SHA>"}` to the version
   file that the project's setup recorded, and prints the previous value. Before
   the project has run setup with a version file, add
   `--version-file /path/to/project/.agents/skills/chill-agent/cli.json` once.
3. Commit that file in the project, following the project's own rules.
4. In the project, start Web or press the update button in an open Web. npm
   fetches and builds the commit on first install, which takes about a minute.

Uncommitted changes in this checkout are not included; the helper notes them.
To return to a release, set the file back to the release archive URL. Releases
still change the version number whenever behavior changes.

Implementation: [use-in](../../scripts/use-in.mjs).
Agent entry: [use a development version](../../.agents/skills/chill-cli-use-development-version/SKILL.md).
