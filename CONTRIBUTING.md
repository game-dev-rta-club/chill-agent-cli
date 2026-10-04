# Contributing

Contributions that make chill-agent-cli simpler, safer, or easier to use are
welcome.

If you have found a security vulnerability, do not open a public issue. Follow
the private reporting process in [SECURITY.md](SECURITY.md).

## Propose a change

- Open a pull request directly for a typo, documentation fix, or small bug fix.
- Open an issue first for workflow, role, protocol, or compatibility changes so
  the behavior and scope can be agreed before implementation.
- Keep refactoring separate from behavior changes.

## Local development

Use Node.js 24 and Git. The Desktop harness integration currently supports macOS.

```sh
git clone https://github.com/game-dev-rta-club/chill-agent-cli.git
cd chill-agent-cli
npm ci
npm run check
```

Run focused tests while developing, then the full check before your pull request.
CI also checks portable JavaScript contracts on Windows; that is not a promise
of a Windows Desktop integration. Keep generated bundles out of source control.

## Documentation ownership

Write for developers using the infrastructure independently. This repository owns
CLI usage, runtime behavior, and extension contracts. Keep detailed specifications
here and let consumer projects link to them. Product onboarding, skills, and
continuation policy belong to chill-agent, not this README. Prefer installed
command help over maintaining duplicate flag lists.

## Pull requests

Keep each pull request focused on one logical change. A pull request should:

- Explain the user-visible problem and the focused solution.
- Include or update tests when behavior or repository contracts change.
- Update user-facing documentation when installation or usage changes.
- Preserve documented platform behavior.
- Pass the complete repository test command.
- Avoid unrelated formatting, refactoring, secrets, and personal information.

Conventional Commit prefixes such as `docs:`, `fix:`, `feat:`, and `test:` are
preferred for commit and pull-request titles.

Maintainers review contributions when available. A response, merge, or release
timeline is not guaranteed.

## Contribution license

No Contributor License Agreement or Developer Certificate of Origin is
required. Unless explicitly stated otherwise, contributions intentionally
submitted for inclusion in this repository are licensed under the repository's
[MIT License](LICENSE).
