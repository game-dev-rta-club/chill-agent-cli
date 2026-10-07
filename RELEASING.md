---
keyPoints: >-
  Release reviewed SemVer tags as GitHub archives after CI and clean-install checks.
  The all-in-one package adopts an exact tested archive in a separate dependency PR.
---

# Releases

Consult the user before changing versions, promoting to main or publishing.
Autonomous develop work does not authorize changes distributed to users.

Use SemVer. Breaking public CLI or extension contracts require a major version.
Keep the CLI protocol version explicit. The all-in-one package adopts a tested
CLI archive with an exact release URL and lockfile integrity, never a floating branch.

1. Open a release PR updating `package.json`, the lockfile, and `CHANGELOG.md`.
2. Run `npm ci`, `npm run check`, and `npm pack`. Test a clean archive install.
3. Merge after required CI. Create `v<version>` on the reviewed commit.
4. The release workflow reruns checks and attaches the npm-installable archive to
   a GitHub Release. Tags cannot be updated or deleted.
5. For a CLI release, open a separate all-in-one dependency-update PR and run its
   integration checks before releasing it.

Archives are distributed through GitHub Releases. npm registry publication is
not configured and no registry credentials are required. Do not document an npm
registry install until a package has actually been published there.

For existing installations, follow [data and runtime updates](docs/runtime/data-and-updates.md)
to adopt the release and verify preserved workspace data.

Agent entry: [read before release](.agents/skills/chill-cli-release/SKILL.md).
