import {open,stat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {recordHidden} from './hidden-failure.mjs';

// Read what a Claude conversation's own transcript says about its model and the
// text its agent wrote. Only public assistant text is kept: never thinking, tool
// input or tool output. Subagent (sidechain) entries are ignored. What the agent
// is doing comes from its hooks (claude-agent-work), not from here. Each file is
// read incrementally.
export const validTranscriptPath = value => typeof value === 'string' && value.length < 4096 && isAbsolute(value) && value.endsWith('.jsonl') && !/[\x00-\x1f]/.test(value);

const indexes = new Map();
async function index(path) {
  let state = indexes.get(path);
  const size = (await stat(path)).size;
  if (!state || size < state.offset) indexes.set(path, state = {offset: 0, rest: '', texts: [], model: null, effort: null});
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
      if (entry.isSidechain || entry.type !== 'assistant' || !entry.message) continue;
      if (entry.message.model) state.model = entry.message.model;
      if (entry.effort) state.effort = entry.effort;
      const text = (Array.isArray(entry.message.content) ? entry.message.content : []).filter(part => part.type === 'text' && part.text?.trim()).map(part => part.text.trim()).join('\n\n');
      if (text) state.texts.push({id: entry.uuid, text, at: Date.parse(entry.timestamp)});
    }
  } finally { await file.close(); }
  return state;
}
const settings = state => state.model ? {model: state.model, reasoning: state.effort || null} : null;

export async function claudeModel(path) {
  if (!validTranscriptPath(path)) return null;
  try { return settings(await index(path)); } catch (error) { if (error.code !== 'ENOENT') recordHidden('claude-transcript.model', error); return null; }
}

// The agent's public text written since `since` (an ISO time): the Think of one
// stretch of work, which the conversation's hooks bound (claude-agent-work).
export async function claudeMessagesSince(path, since) {
  if (!validTranscriptPath(path) || !since) return null;
  try {
    const state = await index(path), from = Date.parse(since);
    return {messages: state.texts.filter(item => item.at >= from), settings: settings(state)};
  } catch (error) { if (error.code !== 'ENOENT') recordHidden('claude-transcript.messages', error); return null; }
}
