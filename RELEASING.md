---
keyPoints: >-
  Release reviewed SemVer tags as GitHub archives after CI and clean-install checks.
  The all-in-one package adopts an exact tested archive in a separate dependency PR.
---

# Releases

Consult the user before changing versions, promoting to main or publishing.
Autonomous develop work does not authorize changes distributed to users.

## Choose a version from the change

Follow [Semantic Versioning 2.0.0](https://semver.org/). Each component is an
unbounded non-negative integer: bug fixes after 1.9.9 become 1.9.10; a compatible
feature becomes 1.10.0. Neither requires 2.0.0. Count changes in behavior, not
commits, elapsed time, branch names or the number of digits.

| Change | Version decision |
| --- | --- |
| Compatible bug fix or documentation correction | PATCH |
| Compatible feature or deprecation | MINOR; reset PATCH |
| Incompatible public contract after 1.0 | MAJOR; reset MINOR/PATCH |
| While 0.y.z: feature or incompatible contract | MINOR, explicitly document breaking changes/migration |

Before 1.0 the API is still evolving; 0.x does not mean unstable code is acceptable.
1.0 is an explicit compatibility commitment, not a response to reaching 0.9.9.
The public surface includes documented commands/flags/output, extension protocol,
persisted workspace compatibility and supported installation paths. Keep protocol
versions explicit and assess them independently of the package version. Never
silently reinterpret stored data or label a breaking change as a patch.

The CLI and app have independent version lines. The app adopts an exact released
CLI archive and integrity, never a floating branch. They need not share numbers.
Each release Changelog records the chosen bump, compatibility impact, migration
instructions when needed, and remaining experimental integrations.

## Prepare and promote

Use npm version <explicit-version> --no-git-tag-version after choosing the bump.
Keep package.json, package-lock.json and npm-shrinkwrap.json root versions aligned.
Run npm run release:check; CI checks their consistency and a matching Changelog
section. The tag workflow also checks tag/version agreement and main ancestry.
These mechanical checks cannot decide whether a change is breaking: review that
classification before promotion. Never move a published tag or replace its assets;
fix a bad release with a new version. Use immutable commit IDs for development
inputs without bumping the published version for every merge.

First integrate the release preparation into develop. Promote develop to main
through a checked PR using a merge commit (not squash), preserving shared ancestry.
Bring that main merge back to develop before the next development change. Tag only
the successful main commit. An explicit user request to publish authorizes that release; the consultation
rule does not require asking again for the same action.

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
