// SQLite extended result codes retain their primary category in the low byte.
// Recovery/snapshot/shared-cache contention must use the same bounded retry as
// BUSY/LOCKED, rather than escaping immediately as an unrelated failure.
// PROTOCOL is a WAL connection that lost the race to start a transaction for
// several seconds: contention as well, which ended the Desktop task on Windows.
export function sqliteBusy(error) {
  return Number.isInteger(error?.errcode)&&[5,6,15].includes(error.errcode&0xff);
}
