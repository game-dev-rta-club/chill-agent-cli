## Summary

Describe the user-visible problem and the focused change that addresses it.

## Verification

List the commands and manual scenarios used to verify the change.

## Dependency and rollout

Target develop for ordinary changes; main only for a release promotion. State
the exact CLI input and clean-checkout command tested. Link prerequisite PRs and
keep this Draft until CI reproduces those inputs. Describe runtime updates separately.

## Integration

Record final head/base and successful checks before merging. After merging, record
the develop commit and post-merge CI result, then remove the topic branch when no
active work depends on it. If blocked, record the reason and next action.

## Checklist

- [ ] The change is limited to one logical concern.
- [ ] Tests were added or updated when behavior or repository contracts changed.
- [ ] The complete repository test command passes locally.
- [ ] User-facing documentation was updated when needed.
- [ ] macOS and Windows compatibility were considered.
- [ ] The diff contains no secrets or personal information.
