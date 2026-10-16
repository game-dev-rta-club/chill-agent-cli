// Generous ceilings for sizes and counts. Small defensive limits failed in
// ways nobody noticed (a hook dropped Web input when a screenshot exceeded
// 64KB), so inputs are accepted up to these and real problems are fixed when
// they show up.
export const largeSize = 256 * 1024 * 1024;
export const largeCount = 100000;
