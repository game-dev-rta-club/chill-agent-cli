import {readFile, realpath, writeFile} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {dataDirectory} from './data-directory.mjs';
import {readJson, withStoreLock, writeJsonAtomically} from './storage.mjs';
import {sameProject} from './project-root.mjs';
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
  if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd) || !await sameProject(input.cwd, cwd))
    throw Error('Claude hook directory does not match its caller.');
  const envFile = env.CLAUDE_ENV_FILE;
  if (typeof envFile !== 'string' || !isAbsolute(envFile)) throw Error('Claude did not provide its environment handoff file.');
  const location = claudeEntryPaths(directory, sessionId);
  return withStoreLock(location.lock, async () => {
    const old = await readJson(location.record);
    const continuing = ['resume', 'compact'].includes(input.source) && old?.version === 1 && old.harnessId === harnessId && old.sessionId === sessionId && uuid.test(old.contextId || '');
    const record = newEntryRecord({sessionId, source:input.source, cwd:await realpath(cwd), ...(continuing ? {contextId:old.contextId} : {})});
    // Web reads the model and public agent text from the conversation's own transcript.
    if (validTranscriptPath(input.transcript_path)) record.transcriptPath = input.transcript_path;
    // A background waiter can outlive compact in the same context.
    if (continuing && old.waiter?.contextId === record.contextId) record.waiter = old.waiter;
    // Replace only our exports in the host's file, preserving other hooks' lines.
    // Failure never commits a usable registration. A crash before the record
    // write leaves a token that cannot resolve; old tokens fail after rotation.
    let current = '';
    try { current = await readFile(envFile, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const kept = current.split('\n').filter(line => !exportLine.test(line)).join('\n').replace(/\n+$/, '');
    await writeFile(envFile, `${kept ? `${kept}\n` : ''}export CHILL_AGENT_HARNESS=${quote(harnessId)}\nexport CHILL_AGENT_SESSION_ID=${quote(sessionId)}\nexport CHILL_AGENT_CONNECTION_GENERATION=${quote(record.generation)}\n`, {mode:0o600});
    await writeJsonAtomically(location.record, record);
    return record;
  });
}

// Claude Code names the conversation in every shell it starts. A conversation
// that was running before setup has no SessionStart handoff; it connects with
// connection join, which only the main-session PostToolUse hook can confirm.
export const nativeSessionId = (env = process.env) => {
  try { return sessionIdentity(env.CLAUDE_CODE_SESSION_ID); } catch { return null; }
};
export const validEntry = (record, sessionId) => record?.version === 1 && record.harnessId === harnessId && record.sessionId === sessionId && uuid.test(record.generation || '');
export function newEntryRecord({sessionId, source, cwd, contextId = randomUUID()}) {
  const at = new Date().toISOString();
  return {version:1, harnessId, sessionId, generation:randomUUID(), source, contextId, cwd, observedAt:at, lastHook:{name:source === 'join' ? 'PostToolUse' : 'SessionStart', at}};
}

export async function identifyClaudeCaller({env=process.env, directory=dataDirectory()}={}) {
  if (env.CHILL_AGENT_HARNESS !== harnessId) {
    const sessionId = nativeSessionId(env);
    if (!sessionId) throw Error('No Claude entry handshake in this shell.');
    const record = await readJson(claudeEntryPaths(directory, sessionId).record);
    if (!validEntry(record, sessionId)) throw Error('This Claude conversation is not connected yet. Run connection join through the main Bash tool; resuming is not required.');
    return callerFrom(record);
  }
  const sessionId = sessionIdentity(env.CHILL_AGENT_SESSION_ID);
  const generation = env.CHILL_AGENT_CONNECTION_GENERATION;
  if (typeof generation !== 'string' || !uuid.test(generation)) throw Error('Claude connection generation is missing or invalid.');
  const record = await readJson(claudeEntryPaths(directory, sessionId).record);
  if (!record || record.version !== 1 || record.harnessId !== harnessId || record.sessionId !== sessionId || record.generation !== generation)
    throw Error('Claude entry is missing or stale; use the current conversation environment.');
  return callerFrom(record);
}
function callerFrom(record) {
  const {sessionId, generation} = record;
  return {stage:'entry-only', identity:{harnessId, sessionId, generation}, observedAt:record.observedAt,
    contextId:record.contextId,
    source:record.source, capabilities:noControls(),
    note:'Local caller identity only. Main-hook actions confirm Goal binding and receipts separately; this handoff does not prove a live return path or enable controls.'};
}
