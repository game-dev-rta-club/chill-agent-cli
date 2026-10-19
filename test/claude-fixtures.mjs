// Claude Code data for tests, built from the recorded samples under
// test/fixtures/claude-code (see scripts/record-claude-samples.mjs). A test names
// only the fields it cares about; everything else keeps the shape Claude Code sends.
import {readFileSync} from 'node:fs';

const directory = new URL('./fixtures/claude-code/', import.meta.url);
const read = file => readFileSync(new URL(file, directory), 'utf8');
const lines = text => text.split('\n').filter(Boolean).map(line => JSON.parse(line));
const copy = value => structuredClone(value);

export const manifest = JSON.parse(read('manifest.json'));
export const hookSchema = JSON.parse(read('hooks.json'));
export const recordedText = name => read(manifest.transcripts.find(sample => sample.name === name).file);
export const recorded = Object.fromEntries(manifest.transcripts.map(sample => [sample.name, lines(recordedText(sample.name))]));

// ---- hook stdin ----------------------------------------------------------------

// One hook input with a field list for its event; `patch` overrides, `undefined` removes.
export function claudeHook(name, patch = {}) {
  const base = hookSchema.events[name]?.example;
  if (!base) throw Error(`No recorded hook shape for ${name}`);
  return Object.fromEntries(Object.entries({...copy(base), ...patch}).filter(([, value]) => value !== undefined));
}
// A hook input as a subagent's tool call sends it.
export const subagentHook = (name, patch = {}) => claudeHook(name, {agent_id: 'agent1', agent_type: 'general-purpose', ...patch});
// Fixes the fields one conversation always shares (session, cwd, prompt).
export const hookFor = shared => (name, patch = {}) => claudeHook(name, {...shared, ...patch});

// ---- transcript entries --------------------------------------------------------

const content = entry => Array.isArray(entry.message?.content) ? entry.message.content : [];
const everything = Object.values(recorded).flat();
const find = (label, test) => ({label, test});
const part = (entry, type) => content(entry).find(p => p.type === type);
const tools = name => entry => entry.type === 'assistant' && content(entry).some(p => p.type === 'tool_use' && p.name === name && !p.input?.run_in_background);
const selectors = {
  prompt: find('prompt', e => e.type === 'user' && !e.isMeta && !e.isSidechain && typeof e.message?.content === 'string' && !e.message.content.startsWith('<')),
  assistantText: find('assistant text', e => e.type === 'assistant' && content(e).some(p => p.type === 'text')),
  assistantTool: find('Bash tool call', tools('Bash')),
  toolResult: find('Bash tool result', e => e.type === 'user' && e.toolUseResult && content(e).some(p => p.type === 'tool_result') && 'stdout' in Object(e.toolUseResult)),
  stop: find('Stop summary', e => e.type === 'system' && e.subtype === 'stop_hook_summary' && !e.hookErrors?.length),
  interrupt: find('interrupt', e => e.type === 'user' && content(e).some(p => p.text === '[Request interrupted by user]')),
};

const found = {};
// Looked up on first use, so a sample that went missing fails the tests that need it with the sample's name.
const templates = new Proxy({}, {get: (_, kind) => {
  const {label, test} = selectors[kind];
  if (!(kind in found)) found[kind] = everything.find(test);
  if (!found[kind]) throw Error(`The recorded samples have no ${label}`);
  return found[kind];
}});

const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const merge = (base, patch = {}) => {
  const result = {...base};
  for (const [key, value] of Object.entries(patch)) result[key] = plainObject(value) && plainObject(base[key]) ? merge(base[key], value) : value;
  return result;
};
// A template with `patch` laid over it; nested objects merge, arrays and scalars replace.
const make = (kind, ...patches) => patches.reduce(merge, copy(templates[kind]));

export const claudeEntry = {
  prompt: (uuid, text = 'Do the work', patch) => make('prompt', {uuid, message: {content: text}}, patch),
  assistant: (uuid, parts, patch) => make('assistantText', {uuid, message: {content: parts}}, patch),
  text: (uuid, text, patch) => claudeEntry.assistant(uuid, [{type: 'text', text}], patch),
  tool: (uuid, name, input, patch, id = `toolu_${uuid}`) => make('assistantTool', {uuid, message: {content: [{...part(templates.assistantTool, 'tool_use'), id, name, input}]}}, patch),
  toolResult: (uuid, toolUseId, text, patch) => make('toolResult', {uuid, message: {content: [{...part(templates.toolResult, 'tool_result'), tool_use_id: toolUseId, content: text}]}, toolUseResult: {stdout: text}}, patch),
  stop: patch => make('stop', patch),
  interrupt: (uuid, patch) => make('interrupt', {uuid}, patch),
};
export const claudeLine = entry => JSON.stringify(entry) + '\n';
export const claudeLines = entries => entries.flat().map(claudeLine).join('');
