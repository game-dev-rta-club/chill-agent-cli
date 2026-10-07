## Summary

Describe the user-visible problem and the focused change that addresses it.

## Verification

List the commands and manual scenarios used to verify the change.

## Dependency and rollout

State the CLI commit/archive tested, if changed. Does a clean install from the
committed dependency pass? Link any prerequisite PR/release and keep this Draft
until it is adopted. Describe whether a local runtime was updated separately.

## Checklist

- [ ] The change is limited to one logical concern.
- [ ] Tests were added or updated when behavior or repository contracts changed.
- [ ] The complete repository test command passes locally.
- [ ] User-facing documentation was updated when needed.
- [ ] macOS and Windows compatibility were considered.
- [ ] The diff contains no secrets or personal information.
