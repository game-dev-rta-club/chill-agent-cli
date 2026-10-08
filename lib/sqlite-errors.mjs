// SQLite extended result codes retain their primary category in the low byte.
// Recovery/snapshot/shared-cache contention must use the same bounded retry as
// BUSY/LOCKED, rather than escaping immediately as an unrelated failure.
export function sqliteBusy(error) {
  return Number.isInteger(error?.errcode)&&[5,6].includes(error.errcode&0xff);
}
