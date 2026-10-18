import {appendFileSync} from 'node:fs';

// Production hides some harness failures on purpose (shows "unknown", null).
// Tests name a file in CHILL_AGENT_HIDDEN_FAILURES to see each one; child
// processes inherit it, so CLI and Web failures land in the same file.
export function recordHidden(where, error) {
  const file = process.env.CHILL_AGENT_HIDDEN_FAILURES;
  if (!file) return;
  try { appendFileSync(file, `${JSON.stringify({where, message: error?.message ?? String(error)})}\n`); } catch { /* Diagnostics must not break the caller. */ }
}

export const hidden = (where, fallback = null) => error => { recordHidden(where, error); return fallback; };
