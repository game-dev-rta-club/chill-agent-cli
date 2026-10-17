import {open,stat} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';

// Read what a Claude conversation's own transcript says about its model and the
// text its agent wrote, as the Codex turn reader does for Codex. Only public
// assistant text is kept: never thinking, tool input or tool output. Subagent
// (sidechain) entries are ignored. Each file is read incrementally.
export const validTranscriptPath = value => typeof value === 'string' && value.length < 4096 && isAbsolute(value) && value.endsWith('.jsonl') && !/[\x00-\x1f]/.test(value);

const indexes = new Map();
// Hook context is a string inside the JSON line, so its quotes are escaped there.
const offerPattern = /\\?"offerId\\?":\\?"([0-9a-f-]{36})/g;
// An AutoContinue request names its attempt in the result command it asks for.
// Its run is the response after the line that carried the request.
const attemptPattern = /--attempt ([0-9a-f-]{36})/g;
function realPrompt(entry) {
  if (entry.type !== 'user' || entry.isSidechain || entry.isMeta || entry.toolUseResult) return false;
  const content = entry.message?.content;
  return typeof content === 'string' ? !content.startsWith('<') : Array.isArray(content) && content.some(part => part.type === 'text' && !part.text?.startsWith('<'));
}
// A background subagent runs on after the response that started it ends. It is
// open from its launch until Claude Code queues its task notification (or the
// agent stops it); background shell commands are not counted, since a server
// and a build look the same.
const taskIdPattern = /<task-id>(\w+)<\/task-id>/g;
const toolUseIdPattern = /<tool-use-id>(\w+)<\/tool-use-id>/g;
const notification = entry => {
  const text = entry.type === 'queue-operation' ? entry.content : entry.type === 'attachment' ? entry.attachment?.prompt : entry.type === 'user' && !entry.toolUseResult ? entry.message?.content : null;
  return typeof text === 'string' && text.includes('<task-notification>') ? text : null;
};
const resultText = part => typeof part.content === 'string' ? part.content : Array.isArray(part.content) ? part.content.map(p => p?.text || '').join('\n') : '';
const interrupted = entry => entry.type === 'user' && Array.isArray(entry.message?.content) && entry.message.content.some(part => part.type === 'text' && part.text?.startsWith('[Request interrupted'));
async function index(path) {
  let state = indexes.get(path);
  const size = (await stat(path)).size;
  if (!state || size < state.offset) indexes.set(path, state = {offset: 0, rest: '', items: [], offers: new Map(), model: null, effort: null, line: 0, active: 0, stopped: 0, launches: new Map(), background: new Map()});
  if (size === state.offset) return state;
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(size - state.offset);
    await file.read(buffer, 0, buffer.length, state.offset);
    state.offset = size;
    const lines = (state.rest + buffer.toString('utf8')).split('\n');
    state.rest = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry; try { entry = JSON.parse(line); } catch { continue; }
      const at = entry.timestamp || null;
      for (const match of line.matchAll(offerPattern)) if (!state.offers.has(match[1])) state.offers.set(match[1], state.items.length);
      if (entry.isSidechain) continue;
      trackBackground(state, entry);
      // The agent's own result command repeats the ID later; the first line wins.
      const attempts = entry.type === 'assistant' || entry.toolUseResult ? [] : [...line.matchAll(attemptPattern)].map(match => match[1]);
      // A turn is open from its last user or assistant entry until Stop or an interrupt.
      state.line++;
      if (entry.type === 'assistant' || entry.type === 'user') state.active = state.line;
      if (interrupted(entry) || entry.type === 'system' && entry.subtype === 'stop_hook_summary') state.stopped = state.line;
      if (entry.type === 'assistant' && entry.message) {
        if (entry.message.model) state.model = entry.message.model;
        if (entry.effort) state.effort = entry.effort;
        const text = (Array.isArray(entry.message.content) ? entry.message.content : []).filter(part => part.type === 'text' && part.text?.trim()).map(part => part.text.trim()).join('\n\n');
        if (text) state.items.push({kind: 'text', id: entry.uuid, text, at});
      } else if (interrupted(entry) || entry.type === 'system' && entry.subtype === 'stop_hook_summary') state.items.push({kind: 'stop', id: entry.uuid, at});
      else if (realPrompt(entry)) state.items.push({kind: 'prompt', id: entry.uuid, at});
      for (const id of attempts) if (!state.offers.has(id)) state.offers.set(id, state.items.length);
    }
  } finally { await file.close(); }
  return state;
}

function trackBackground(state, entry) {
  const content = Array.isArray(entry.message?.content) ? entry.message.content : [];
  if (entry.type === 'assistant') for (const part of content) {
    if (part.type === 'tool_use' && ['Agent', 'Task'].includes(part.name) && part.input?.run_in_background === true) state.launches.set(part.id, state.items.length);
  }
  if (entry.type === 'user' && entry.toolUseResult) for (const part of content) {
    if (part.type !== 'tool_result' || !state.launches.has(part.tool_use_id)) continue;
    const agentId = resultText(part).match(/agentId: (\w+)/)?.[1];
    if (agentId) state.background.set(part.tool_use_id, {agentId, item: state.launches.get(part.tool_use_id)});
    state.launches.delete(part.tool_use_id);
  }
  const text = notification(entry);
  // A subagent that stopped with background work of its own notifies again later.
  if (!text || text.includes('background work of its own still running')) return;
  const ended = new Set([...text.matchAll(taskIdPattern), ...text.matchAll(toolUseIdPattern)].map(match => match[1]));
  for (const [id, task] of state.background) if (ended.has(id) || ended.has(task.agentId)) state.background.delete(id);
}
// Open background subagents whose own transcript was written within staleMs,
// so one ended with its app (no notification) does not stay open. `from`/`to`
// limit them to those launched within a range of response items.
async function openBackground(path, state, {now, staleMs, from = 0, to = Infinity}) {
  const folder = join(path.slice(0, -'.jsonl'.length), 'subagents');
  let count = 0;
  for (const task of state.background.values()) {
    if (task.item < from || task.item >= to) continue;
    const written = await stat(join(folder, `agent-${task.agentId}.jsonl`)).then(s => s.mtimeMs, () => null);
    if (written != null && now() - written < staleMs) count++;
  }
  return count;
}

export async function claudeModel(path) {
  if (!validTranscriptPath(path)) return null;
  try { const {model, effort} = await index(path); return model ? {model, reasoning: effort || null} : null; } catch { return null; }
}

// The conversation's current response: its turn ID, as claudeWork reports it,
// and whether it is still open. A transcript left without a Stop for longer
// than staleMs (a closed app, a crash) counts as not running. `background`
// counts subagents still working after their response ended.
export async function claudeTurn(path, {now = Date.now, staleMs = 10 * 60 * 1000} = {}) {
  if (!validTranscriptPath(path)) return null;
  try {
    const {mtimeMs} = await stat(path), state = await index(path);
    const boundary = state.items.findLast(item => item.kind !== 'text');
    return {turnId: `claude:${boundary?.id || 'start'}`, running: state.active > state.stopped && now() - mtimeMs < staleMs,
      background: await openBackground(path, state, {now, staleMs})};
  } catch { return null; }
}
export async function claudeRunning(path, options) { return (await claudeTurn(path, options))?.running ?? null; }

// The turn that received a feedback offer: text written after the offer until
// that response stopped or the user started another prompt.
export async function claudeWork(path, offerId, {now = Date.now, staleMs = 10 * 60 * 1000} = {}) {
  if (!validTranscriptPath(path) || typeof offerId !== 'string') return null;
  let state; try { state = await index(path); } catch { return null; }
  const start = state.offers.get(offerId);
  if (start === undefined) return null;
  // Feedback offered within one response shares that response, as one Codex turn.
  const first = state.items.slice(0, start).findLastIndex(item => item.kind !== 'text'), boundary = state.items[first];
  const messages = [];let endedAt = null, end = null;
  for (const [i, item] of state.items.slice(start).entries()) {
    if (item.kind === 'text') messages.push({id: item.id, text: item.text, at: item.at ? Date.parse(item.at) : null});
    else { endedAt = item.at; end = start + i; break; }
  }
  // A response that ended with its subagents still working is still Running.
  const background = end != null ? await openBackground(path, state, {now, staleMs, from: first + 1, to: end + 1}) : 0;
  return {source: 'turn', turnId: `claude:${boundary?.id || 'start'}`, status: end != null && !background ? 'completed' : 'working', background, settings: state.model ? {model: state.model, reasoning: state.effort || null} : null,
    startedAt: null, endedAt, messages, truncated: false};
}
