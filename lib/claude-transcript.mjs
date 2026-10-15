import {open,stat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';

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
const interrupted = entry => entry.type === 'user' && Array.isArray(entry.message?.content) && entry.message.content.some(part => part.type === 'text' && part.text?.startsWith('[Request interrupted'));
async function index(path) {
  let state = indexes.get(path);
  const size = (await stat(path)).size;
  if (!state || size < state.offset) indexes.set(path, state = {offset: 0, rest: '', items: [], offers: new Map(), model: null, effort: null, line: 0, active: 0, stopped: 0});
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

export async function claudeModel(path) {
  if (!validTranscriptPath(path)) return null;
  try { const {model, effort} = await index(path); return model ? {model, reasoning: effort || null} : null; } catch { return null; }
}

// The conversation's current response: its turn ID, as claudeWork reports it,
// and whether it is still open. A transcript left without a Stop for longer
// than staleMs (a closed app, a crash) counts as not running.
export async function claudeTurn(path, {now = Date.now, staleMs = 10 * 60 * 1000} = {}) {
  if (!validTranscriptPath(path)) return null;
  try {
    const {mtimeMs} = await stat(path), state = await index(path);
    const boundary = state.items.findLast(item => item.kind !== 'text');
    return {turnId: `claude:${boundary?.id || 'start'}`, running: state.active > state.stopped && now() - mtimeMs < staleMs};
  } catch { return null; }
}
export async function claudeRunning(path, options) { return (await claudeTurn(path, options))?.running ?? null; }

// The turn that received a feedback offer: text written after the offer until
// that response stopped or the user started another prompt.
export async function claudeWork(path, offerId) {
  if (!validTranscriptPath(path) || typeof offerId !== 'string') return null;
  let state; try { state = await index(path); } catch { return null; }
  const start = state.offers.get(offerId);
  if (start === undefined) return null;
  // Feedback offered within one response shares that response, as one Codex turn.
  const boundary = state.items.slice(0, start).findLast(item => item.kind !== 'text');
  const messages = [];let endedAt = null;
  for (const item of state.items.slice(start)) {
    if (item.kind === 'text') messages.push({id: item.id, text: item.text, at: item.at ? Date.parse(item.at) : null});
    else { endedAt = item.at; break; }
  }
  return {source: 'turn', turnId: `claude:${boundary?.id || 'start'}`, status: endedAt ? 'completed' : 'working', settings: state.model ? {model: state.model, reasoning: state.effort || null} : null,
    startedAt: null, endedAt, messages, truncated: false};
}
