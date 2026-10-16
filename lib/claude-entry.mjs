import {readFile, realpath, writeFile} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {dataDirectory} from './data-directory.mjs';
import {readJson, withStoreLock, writeJsonAtomically} from './storage.mjs';
import {validTranscriptPath} from './claude-transcript.mjs';

const harnessId = 'claude-code';
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function sessionIdentity(value) {
  // Native IDs are opaque, not Codex UUIDs or filesystem paths.
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\x00-\x1f\x7f]/.test(value))
    throw Error('Claude session identity is missing or invalid.');
  return value;
}
export function claudeEntryPaths(directory, sessionId) {
  sessionIdentity(sessionId);
  const key = createHash('sha256').update(sessionId).digest('hex');
  const base = join(directory, 'workspace', 'connections', harnessId);
  return {record:join(base, `${key}.json`), lock:join(base, 'locks', key)};
}
// A reply waiter refreshes its record while it runs. Freshness, not a process
// ID, decides liveness, so a reused PID never hides a stopped waiter.
export const waiterRefreshMs = 30000;
export const waiterRunning = (record, now = Date.now()) => !!record?.waiter && record.waiter.contextId === record.contextId &&
  now - Date.parse(record.waiter.checkedAt) < waiterRefreshMs * 3;
// Claude Desktop pauses idle conversations when memory runs low, and the watcher
// hook stops with them. It never pauses one with a background task running, so
// there the waiter runs as a task (connection wait) and the hook only stands by.
export const desktopPausesIdle = (env = process.env) => env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop';
export const taskWaiterRunning = (record, now = Date.now()) => waiterRunning(record, now) && record.waiter.kind !== 'hook';
const exportLine = /^export CHILL_AGENT_(HARNESS|SESSION_ID|CONNECTION_GENERATION)=/;
const noControls = () => ({goalBinding:false, feedback:false, idleWake:false, settings:false, stop:false, resume:false});

// A local hook-to-CLI handshake, not authentication or proof of a live return
// path. In particular, it never assigns a Goal, starts work, or reads a transcript.
export async function captureClaudeEntry(input, {env=process.env, directory=dataDirectory(), cwd=process.cwd()}={}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Expected Claude hook input.');
  if (input.agent_id != null) return null;
  if (input.hook_event_name !== 'SessionStart') return null;
  if (!['startup', 'resume', 'clear', 'compact', 'fork'].includes(input.source)) throw Error('Unsupported Claude session start.');
  const sessionId = sessionIdentity(input.session_id);
  const envFile = typeof env.CLAUDE_ENV_FILE === 'string' && isAbsolute(env.CLAUDE_ENV_FILE) ? env.CLAUDE_ENV_FILE : null;
  const location = claudeEntryPaths(directory, sessionId);
  return withStoreLock(location.lock, async () => {
    const old = await readJson(location.record);
    const continuing = ['resume', 'compact'].includes(input.source) && old?.version === 1 && old.harnessId === harnessId && old.sessionId === sessionId && uuid.test(old.contextId || '');
    const record = newEntryRecord({sessionId, source:input.source, cwd:await realpath(cwd), ...(continuing ? {contextId:old.contextId} : {})});
    // Web reads the model and public agent text from the conversation's own transcript.
    if (validTranscriptPath(input.transcript_path)) record.transcriptPath = input.transcript_path;
    // A background waiter can outlive compact in the same context.
    if (continuing && old.waiter?.contextId === record.contextId) record.waiter = old.waiter;
    // A Web pause and a pending resume belong to the context, not the shell.
    if (continuing) for (const key of ['pause', 'resumeRequested', 'approveAll']) if (old[key]) record[key] = old[key];
    // Replace only our exports in the host's file, preserving other hooks' lines
    // and dropping the connection generation earlier versions exported. The
    // generation stays internal: agents never carry it, so it cannot go stale.
    // Claude Code also names the conversation itself (CLAUDE_CODE_SESSION_ID).
    if (envFile) {
      let current = '';
      try { current = await readFile(envFile, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const kept = current.split('\n').filter(line => !exportLine.test(line)).join('\n').replace(/\n+$/, '');
      await writeFile(envFile, `${kept ? `${kept}\n` : ''}export CHILL_AGENT_HARNESS=${quote(harnessId)}\nexport CHILL_AGENT_SESSION_ID=${quote(sessionId)}\n`, {mode:0o600});
    }
    await writeJsonAtomically(location.record, record);
    return record;
  });
}

// Claude Code names the conversation in every shell it starts. A conversation
// that was running before setup has no SessionStart handoff; it connects with
// connection join.
export const nativeSessionId = (env = process.env) => {
  try { return sessionIdentity(env.CLAUDE_CODE_SESSION_ID); } catch { return null; }
};
export const validEntry = (record, sessionId) => record?.version === 1 && record.harnessId === harnessId && record.sessionId === sessionId && uuid.test(record.generation || '');
export function newEntryRecord({sessionId, source, cwd, contextId = randomUUID()}) {
  const at = new Date().toISOString();
  return {version:1, harnessId, sessionId, generation:randomUUID(), source, contextId, cwd, observedAt:at, lastHook:{name:source === 'join' ? 'PostToolUse' : 'SessionStart', at}};
}

// Claude Code names its own conversation in every shell (CLAUDE_CODE_SESSION_ID),
// so the caller is found from that and the current record. Nothing the agent
// carries can go stale: compact or resume never breaks a running command.
export async function identifyClaudeCaller({env=process.env, directory=dataDirectory()}={}) {
  let sessionId = nativeSessionId(env);
  if (!sessionId && env.CHILL_AGENT_HARNESS === harnessId) sessionId = sessionIdentity(env.CHILL_AGENT_SESSION_ID);
  if (!sessionId) throw Error('No Claude entry handshake in this shell.');
  const record = await readJson(claudeEntryPaths(directory, sessionId).record);
  if (!validEntry(record, sessionId)) throw Error('This Claude conversation is not connected yet. Run connection join through the main Bash tool; resuming is not required.');
  return callerFrom(record);
}
function callerFrom(record) {
  const {sessionId, generation} = record;
  return {stage:'entry-only', identity:{harnessId, sessionId, generation}, observedAt:record.observedAt,
    contextId:record.contextId,
    source:record.source, capabilities:noControls(),
    note:'Local caller identity only. It does not prove a live return path or enable controls.'};
}
