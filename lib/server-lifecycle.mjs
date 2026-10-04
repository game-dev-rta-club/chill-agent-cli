import { parseOptions } from './cli-help.mjs';
import { mkdir, open, stat } from 'node:fs/promises';
import { join } from 'node:path';

export function serverOptions(args = [], env = process.env) {
  const values = parseOptions('server start', args);
  const duration = values['--idle-timeout'] ?? env.CHILL_AGENT_IDLE_TIMEOUT ?? '3d';
  const tunnel = Boolean(values['--tunnel']), configured = Boolean(values['--configured']), local = Boolean(values['--local']);
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(duration);
  const units = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  const idleTimeoutMs = match ? Number(match[1]) * units[match[2]] : NaN;
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1) throw new Error('Idle timeout must be a positive duration, for example 3d or 30m.');
  const port = Number(env.PORT ?? 4173);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer between 0 and 65535.');
  return { port, duration, idleTimeoutMs, tunnel, configured, local };
}

// Shared with the CLI: mutations renew the server lease; reads and polling do not.
export async function recordServerUse(directory) {
  try {
    await mkdir(join(directory, 'runtime'), { recursive: true });
    const file = await open(join(directory, 'runtime', 'last-use'), 'a', 0o600);
    try { const now = new Date(); await file.utimes(now, now); }
    finally { await file.close(); }
  } catch (error) {
    // A failed lease update must not turn a successfully saved reply into a retry.
    console.error(`Could not renew server idle timeout: ${error.message}`);
  }
}

export async function lastServerUse(directory, startedAt) {
  try { return Math.max(startedAt, (await stat(join(directory, 'runtime', 'last-use'))).mtimeMs); }
  catch (error) { if (error.code === 'ENOENT') return startedAt; throw error; }
}

export function watchServerIdle({ directory, idleTimeoutMs, startedAt = Date.now(), isBusy, canStop=()=>true, onIdle }) {
  let timer, stopped = false;
  // Check the persisted time after sleep and before shutdown, including CLI updates.
  const interval = Math.min(30000, Math.max(20, idleTimeoutMs / 10));
  async function check() {
    let wait = interval;
    try {
      const remaining = await lastServerUse(directory, startedAt) + idleTimeoutMs - Date.now();
      if (stopped) return;
      // Once expired, promptly retry after transient startup/request work drains.
      if (remaining <= 0) wait = Math.min(interval, 1000);
      if (remaining <= 0 && !await isBusy()) {
        // Work may have saved data while the asynchronous busy check was running.
        if (!stopped && await lastServerUse(directory, startedAt) + idleTimeoutMs <= Date.now() && canStop()) { stopped = true; onIdle(); return; }
      }
      if (remaining > 0) wait = Math.min(wait, remaining);
    } catch (error) {
      console.error(`Could not check server idle timeout: ${error.message}`);
    }
    if (!stopped) { timer = setTimeout(check, Math.max(1, wait)); timer.unref(); }
  }
  void check();
  return () => { stopped = true; clearTimeout(timer); };
}
