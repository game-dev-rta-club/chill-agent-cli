import {appendFile, realpath} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {dataDirectory} from './data-directory.mjs';
import {readJson, withStoreLock, writeJsonAtomically} from './storage.mjs';

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
// Correlate sibling native hooks without accepting another process's resume.
export const claudeResumeHookKey=(input,parentPid=process.ppid)=>createHash('sha256').update(JSON.stringify([parentPid,input])).digest('hex');
const noControls = () => ({goalBinding:false, feedback:false, idleWake:false, settings:false, stop:false, resume:false});

// A local hook-to-CLI handshake, not authentication or proof of a live return
// path. In particular, it never assigns a Goal, starts work, or reads a transcript.
export async function captureClaudeEntry(input, {env=process.env, directory=dataDirectory(), cwd=process.cwd()}={}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Expected Claude hook input.');
  if (input.agent_id != null) return null;
  if (input.hook_event_name !== 'SessionStart') return null;
  if (!['startup', 'resume', 'clear', 'compact', 'fork'].includes(input.source)) throw Error('Unsupported Claude session start.');
  const sessionId = sessionIdentity(input.session_id);
  if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd) || await realpath(input.cwd) !== await realpath(cwd))
    throw Error('Claude hook directory does not match its caller.');
  const envFile = env.CLAUDE_ENV_FILE;
  if (typeof envFile !== 'string' || !isAbsolute(envFile)) throw Error('Claude did not provide its environment handoff file.');
  const location = claudeEntryPaths(directory, sessionId);
  return withStoreLock(location.lock, async () => {
    const old = await readJson(location.record);
    const continuing = ['resume', 'compact'].includes(input.source) && old?.version === 1 && old.harnessId === harnessId && old.sessionId === sessionId && uuid.test(old.contextId || '');
    const record = {version:1, harnessId, sessionId, generation:randomUUID(), source:input.source,
      contextId:continuing ? old.contextId : randomUUID(),
      cwd:await realpath(cwd), observedAt:new Date().toISOString(),
      lastHook:{name:'SessionStart',at:new Date().toISOString()}};
    if(continuing&&input.source==='resume')record.resumeCheckpoint={checkpointId:randomUUID(),generation:record.generation,contextId:record.contextId,hookKey:claudeResumeHookKey(input)};
    // Append to the host's file, preserving other hooks. Failure never commits
    // a usable registration. A crash before the record write leaves a token
    // that cannot resolve; old tokens fail after successful generation rotation.
    await appendFile(envFile, `\nexport CHILL_AGENT_HARNESS=${quote(harnessId)}\nexport CHILL_AGENT_SESSION_ID=${quote(sessionId)}\nexport CHILL_AGENT_CONNECTION_GENERATION=${quote(record.generation)}\n`, {mode:0o600});
    await writeJsonAtomically(location.record, record);
    return record;
  });
}

export async function identifyClaudeCaller({env=process.env, directory=dataDirectory()}={}) {
  if (env.CHILL_AGENT_HARNESS !== harnessId) throw Error('No Claude entry handshake in this shell.');
  const sessionId = sessionIdentity(env.CHILL_AGENT_SESSION_ID);
  const generation = env.CHILL_AGENT_CONNECTION_GENERATION;
  if (typeof generation !== 'string' || !uuid.test(generation)) throw Error('Claude connection generation is missing or invalid.');
  const record = await readJson(claudeEntryPaths(directory, sessionId).record);
  if (!record || record.version !== 1 || record.harnessId !== harnessId || record.sessionId !== sessionId || record.generation !== generation)
    throw Error('Claude entry is missing or stale; use the current conversation environment.');
  return {stage:'entry-only', identity:{harnessId, sessionId, generation}, observedAt:record.observedAt,
    contextId:record.contextId,
    source:record.source, capabilities:noControls(),
    note:'Local caller identity only. Main-hook actions confirm Goal binding and receipts separately; this handoff does not prove a live return path or enable controls.'};
}
