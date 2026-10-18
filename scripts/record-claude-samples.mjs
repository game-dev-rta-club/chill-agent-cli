#!/usr/bin/env node
// Record redacted Claude Code samples as test fixtures under test/fixtures/claude-code.
//
//   node scripts/record-claude-samples.mjs [--claude-version X.Y.Z] [--projects DIR] [--binary PATH] [--out DIR]
//
// Transcripts are read from local Claude Code sessions (read only). Each scenario takes
// the smallest real window of entries that shows what chill reads, then redacts it:
// keys and types stay, as do the exact marker strings chill matches; every other
// string becomes a placeholder and IDs, timestamps and paths are replaced. The result
// is audited string by string, so an unforeseen field can only be refused, never leak.
// Hook stdin is not recorded anywhere on disk, so its fields come from the hook input
// schema inside the Claude Code binary (the same code that builds the stdin).
import {existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {homedir, userInfo} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const projects = option('--projects', join(homedir(), '.claude', 'projects'));
const out = resolve(option('--out', join(root, 'test', 'fixtures', 'claude-code')));
const placeholder = '(redacted)';
const baseTime = Date.parse('2026-01-01T00:00:00.000Z');

// ---- redaction -----------------------------------------------------------------

const uuidText = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isoText = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
const tagText = /^<([a-z][a-z0-9-]*)[ >]/;
// Values that stay verbatim under these keys when they look like an enumeration word.
const enumKeys = new Set(['type', 'subtype', 'role', 'model', 'effort', 'version', 'operation', 'status', 'userType', 'entrypoint', 'level', 'hookEvent', 'hookName',
  'stop_reason', 'commandMode', 'kind', 'producer', 'permissionMode', 'mode', 'promptSource', 'turnOrigin', 'origin', 'taskType']);
const enumValue = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,40}$/;
const tools = new Set(['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'Agent', 'Task', 'TodoWrite']);
const keptAttachments = new Set(['hook_additional_context', 'queued_command']);
const droppedKeys = new Set(['usage', 'diagnostics', 'input_transformations', 'context_management', 'wireIngestContext', 'wireToolInputs']);
const pinned = {cwd: '/example/project', gitBranch: 'main', slug: 'example-slug'};

const fixedTexts = ['[Request interrupted by user]', '[Request interrupted by user for tool use]', 'Async agent launched successfully.',
  'This agent stopped with background work of its own still running.'];

class Aliases {
  counters = new Map(); known = new Map();
  of(kind, real) {
    const key = `${kind}\0${real}`;
    if (!this.known.has(key)) {
      const n = (this.counters.get(kind) || 0) + 1;
      this.counters.set(kind, n);
      this.known.set(key, kind === 'uuid' ? `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` : kind.endsWith('_') ? `${kind}fixture${n}` : `${kind}${n}`);
    }
    return this.known.get(key);
  }
}

class Redactor {
  aliases = new Aliases(); epoch = null; allowed = new Map();
  time(text) {
    const at = Date.parse(text);
    this.epoch ??= at;
    return new Date(baseTime + Math.min(Math.max(at - this.epoch, 0), 30 * 864e5)).toISOString();
  }
  uuid(text) { return this.aliases.of('uuid', text); }
  // The markers chill matches in text, rebuilt around placeholders.
  text(value) {
    if (value === '') return '';
    for (const fixed of fixedTexts) if (value === fixed) return value;
    if (value.includes('<task-notification>')) return this.notification(value);
    const handed = [...value.matchAll(/\\?"eventId\\?":(\d+),\\?"goalId\\?":(\d+)/g)];
    if (handed.length) return `${placeholder}\n${JSON.stringify(handed.map(m => ({eventId: Number(m[1]), goalId: Number(m[2])})))}`;
    const agent = value.match(/agentId: (\w+)/);
    if (agent) return `${value.startsWith(fixedTexts[2]) ? `${fixedTexts[2]}\n` : ''}agentId: ${this.aliases.of('agent', agent[1])} ${placeholder}`;
    const tag = value.match(tagText);
    return tag ? `<${tag[1]}>${placeholder}</${tag[1]}>` : placeholder;
  }
  notification(value) {
    const id = (tag, kind) => value.match(new RegExp(`<${tag}>(\\w+)</${tag}>`))?.[1] ? `<${tag}>${this.aliases.of(kind, value.match(new RegExp(`<${tag}>(\\w+)</${tag}>`))[1])}</${tag}>` : null;
    const note = value.includes(fixedTexts[3]) ? `<note>${fixedTexts[3]}</note>` : null;
    const status = value.match(/<status>([a-z]+)<\/status>/)?.[1];
    return ['<task-notification>', id('task-id', 'agent'), id('tool-use-id', 'toolu_'), status && `<status>${status}</status>`, `<summary>${placeholder}</summary>`, note, '</task-notification>'].filter(Boolean).join('\n');
  }
  string(value, key, parent) {
    if (key === 'timestamp' || isoText.test(value)) return this.time(value);
    if (uuidText.test(value)) return this.uuid(value);
    if (key in pinned) return pinned[key];
    if (parent?.type === 'tool_use' && key === 'name') return tools.has(value) ? value : placeholder;
    if (/^(toolu|msg|req)_[A-Za-z0-9]+$/.test(value)) return this.aliases.of(`${value.split('_')[0]}_`, value);
    if (/(^id|Id|ID|_id|Uuid|_uuid)$/.test(key) && /^[\w-]{4,64}$/.test(value)) return this.aliases.of(key === 'agentId' ? 'agent' : 'id', value);
    if (enumKeys.has(key) && enumValue.test(value)) return value;
    return this.text(value);
  }
  value(v, key = '', parent = null, depth = 0) {
    if (typeof v === 'string') return this.string(v, key, parent);
    if (Array.isArray(v)) return depth > 5 ? [] : v.slice(0, 8).map(x => this.value(x, key, parent, depth + 1));
    if (!v || typeof v !== 'object') return v;
    if (depth > 5) return {};
    const result = {};
    for (const [k, x] of Object.entries(v)) if (!droppedKeys.has(k)) result[k] = this.value(x, k, v, depth + 1);
    return result;
  }
  // A tool outside the allowlist keeps its slot but not its name, input or result.
  entry(entry) {
    const copy = {...entry};
    const parts = Array.isArray(copy.message?.content) ? copy.message.content : [];
    if (copy.type === 'assistant') copy.message = {...copy.message, content: parts.map(part => {
      if (part.type !== 'tool_use') return part;
      this.allowed.set(part.id, tools.has(part.name));
      return tools.has(part.name) ? part : {...part, name: placeholder, input: {}};
    })};
    if (copy.toolUseResult && !parts.every(part => part.type !== 'tool_result' || this.allowed.get(part.tool_use_id))) copy.toolUseResult = {};
    if (copy.type === 'attachment' && !keptAttachments.has(copy.attachment?.type)) copy.attachment = {type: copy.attachment?.type};
    return this.value(copy);
  }
}

// ---- audit ---------------------------------------------------------------------

const fakeText = [/^\(redacted\)$/, /^<[a-z][a-z0-9-]*>\(redacted\)<\/[a-z][a-z0-9-]*>$/, /^00000000-0000-4000-8000-\d{12}$/, /^(toolu|msg|req)_fixture\d+$/,
  /^(agent|id)\d+$/, /^2026-\d\d-\d\dT[\d:.]+Z$/, /^\(redacted\)\n\[(\{"eventId":\d+,"goalId":\d+\},?)+\]$/,
  /^(Async agent launched successfully\.\n)?agentId: agent\d+ \(redacted\)$/,
  /^<task-notification>\n(<task-id>agent\d+<\/task-id>\n)?(<tool-use-id>toolu_fixture\d+<\/tool-use-id>\n)?(<status>[a-z]+<\/status>\n)?<summary>\(redacted\)<\/summary>\n(<note>This agent stopped with background work of its own still running\.<\/note>\n)?<\/task-notification>$/,
  /^\/example\/project$/, /^main$/, /^example-slug$/];
function audit(v, key = '', parent = null) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(key) && key !== '') throw Error(`Refusing unusual key "${key}"`);
  if (typeof v === 'string') {
    const ok = fixedTexts.includes(v) || v === '' || fakeText.some(re => re.test(v)) || enumKeys.has(key) && enumValue.test(v) || parent?.type === 'tool_use' && key === 'name' && tools.has(v);
    if (!ok) throw Error(`Refusing unredacted string under "${key}" (shaped ${v.replace(/[A-Za-z]/g, 'a').replace(/\d/g, '9').slice(0, 40)})`);
  } else if (Array.isArray(v)) v.forEach(x => audit(x, key, parent));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) audit(x, k, v);
}
function denylist(sources) {
  const words = new Set([userInfo().username, homedir(), ...sources].filter(w => w && w.length > 4 && !Object.values(pinned).includes(w)));
  return text => {
    for (const word of words) if (text.toLowerCase().includes(word.toLowerCase())) throw Error(`Fixture still contains "${word}"`);
    const leak = text.match(/\/Users\/|\/private\/|\/home\/|@[\w-]+\.[a-z]{2,}|\bsk-[A-Za-z0-9]{20}|\bgh[ps]_[A-Za-z0-9]{20}|Bearer /);
    if (leak) throw Error(`Fixture contains ${leak[0]}`);
  };
}

// ---- transcripts ---------------------------------------------------------------

function* sessionFiles(dir) {
  for (const item of readdirSync(dir, {withFileTypes: true})) {
    const path = join(dir, item.name);
    if (item.isDirectory()) yield* sessionFiles(path);
    else if (item.name.endsWith('.jsonl')) yield path;
  }
}
const load = path => readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const content = entry => Array.isArray(entry.message?.content) ? entry.message.content : [];
const isPrompt = e => e.type === 'user' && !e.isSidechain && !e.isMeta && !e.toolUseResult && typeof e.message?.content === 'string' && !e.message.content.startsWith('<');
const isStop = e => e.type === 'system' && e.subtype === 'stop_hook_summary' && !e.isSidechain;
const isInterrupt = e => e.type === 'user' && content(e).some(p => p.type === 'text' && p.text?.startsWith('[Request interrupted'));
const noteOf = e => typeof e.content === 'string' ? e.content : typeof e.message?.content === 'string' ? e.message.content : '';
const hasFeedback = e => e.type === 'attachment' && e.attachment?.type === 'hook_additional_context' && JSON.stringify(e.attachment.content).includes('chill-agent: Web feedback');
const launches = e => e.type === 'assistant' ? content(e).filter(p => p.type === 'tool_use' && ['Agent', 'Task'].includes(p.name) && p.input?.run_in_background === true) : [];
const backward = (list, i, test) => { for (let j = i; j >= 0; j--) if (test(list[j])) return j; return -1; };
const forward = (list, i, test) => { for (let j = i; j < list.length; j++) if (test(list[j])) return j; return -1; };
// The main conversation's own entries; subagent entries and non-conversation records are dropped.
const conversation = e => ['user', 'assistant', 'system', 'attachment', 'queue-operation'].includes(e.type) && !e.isSidechain;

// Each scenario yields candidate windows (arrays of entries) from one session.
const scenarios = {
  'feedback-turn': {about: 'a prompt, Web feedback handed by a tool hook, the work after it, and the Stop that ends the response', *windows(list) {
    for (let i = 0; i < list.length; i++) {
      if (!hasFeedback(list[i])) continue;
      const start = backward(list, i, isPrompt), end = forward(list, i, isStop);
      if (start < 0 || end < 0) continue;
      const window = list.slice(start, end + 1).filter(conversation);
      if (window.some(e => e.type === 'assistant' && !e.isSidechain && content(e).some(p => p.type === 'text')) && window.length <= 60) yield window;
    }
  }},
  'interrupted-turn': {about: 'a prompt, some work, and the user interrupting the response', *windows(list) {
    for (let i = 0; i < list.length; i++) {
      if (!isInterrupt(list[i]) || !content(list[i]).some(p => p.text === '[Request interrupted by user]')) continue;
      const start = backward(list, i, isPrompt);
      if (start >= 0 && list.slice(start, i).some(e => e.type === 'assistant')) yield list.slice(start, i + 1).filter(conversation);
    }
  }},
  'tool-interrupted-turn': {about: 'a response interrupted while a tool was running', *windows(list) {
    for (let i = 0; i < list.length; i++) {
      if (!isInterrupt(list[i]) || !content(list[i]).some(p => p.text === '[Request interrupted by user for tool use]')) continue;
      const start = backward(list, i, isPrompt);
      if (start >= 0 && list.slice(start, i).some(e => e.type === 'assistant')) yield list.slice(start, i + 1).filter(conversation);
    }
  }},
  'background-agent': {about: 'a background subagent launched, the response ending, and its task notification arriving later', *windows(list) {
    for (let i = 0; i < list.length; i++) {
      for (const launch of launches(list[i])) {
        const result = forward(list, i + 1, e => e.toolUseResult && content(e).some(p => p.tool_use_id === launch.id));
        const agentId = result < 0 ? null : JSON.stringify(content(list[result])).match(/agentId: (\w+)/)?.[1];
        const stop = result < 0 ? -1 : forward(list, result, isStop);
        const notice = agentId ? forward(list, stop + 1, e => ['queue-operation', 'user'].includes(e.type) && noteOf(e).includes('<task-notification>') && noteOf(e).includes(`<task-id>${agentId}</task-id>`) && !noteOf(e).includes(fixedTexts[3])) : -1;
        const end = notice < 0 || stop < 0 ? -1 : forward(list, notice, isStop);
        if (end < 0) continue;
        // The launch alone is enough of a response; its prompt is kept only when close by.
        const prompt = backward(list, i, isPrompt), run = list.slice(prompt >= 0 && stop - prompt < 30 ? prompt : i, stop + 1).filter(conversation), tail = list.slice(notice, end + 1).filter(conversation);
        if (run.length <= 40 && tail.length <= 12) yield Object.assign([...run, ...tail], {agentId});
      }
    }
  }},
};

const files = [...sessionFiles(projects)].filter(p => !p.includes(`${'/'}subagents${'/'}`) && statSync(p).size < 200e6).sort();
// Samples come from one release so a fixture set describes a single Claude Code version:
// the one with the most recorded lines unless --claude-version names another.
const wantedVersion = option('--claude-version', (() => {
  const counts = {};
  for (const path of files) for (const [, version] of readFileSync(path, 'utf8').matchAll(/"version":"(\d+\.\d+\.\d+)"/g)) counts[version] = (counts[version] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
})());
if (!wantedVersion) throw Error(`No Claude Code transcripts under ${projects}`);

const found = new Map();

for (const path of files) {
  const list = load(path);
  for (const [name, scenario] of Object.entries(scenarios)) {
    for (const window of scenario.windows(list)) {
      const version = window.find(e => e.version)?.version ?? list.find(e => e.version)?.version;
      const best = found.get(name);
      if ((scenarios[name].anyVersion || version === wantedVersion && window.every(e => !e.version || e.version === version)) && (!best || window.length < best.window.length)) found.set(name, {window, version, path, agentId: window.agentId});
    }
  }
}

// Nothing is written until every sample is built, audited and checked.
const redactor = new Redactor(), written = [], sources = new Set(), outputs = new Map();
const emit = (relative, entries) => {
  const text = entries.map(entry => JSON.stringify(redactor.entry(entry)) + '\n').join('');
  for (const line of text.split('\n').filter(Boolean)) audit(JSON.parse(line));
  outputs.set(relative, text);
};
for (const name of Object.keys(scenarios)) {
  const hit = found.get(name);
  if (!hit) throw Error(`No real ${wantedVersion} window found for ${name}; nothing was written.`);
  for (const e of hit.window) for (const key of ['cwd', 'gitBranch', 'slug']) if (typeof e[key] === 'string') sources.add(e[key]);
  redactor.epoch = null;
  emit(`transcripts/${name}.jsonl`, hit.window);
  const entry = {name, file: `transcripts/${name}.jsonl`, claudeCodeVersion: hit.version, entries: hit.window.length, about: scenarios[name].about};
  const sibling = hit.agentId && join(hit.path.slice(0, -'.jsonl'.length), 'subagents', `agent-${hit.agentId}.jsonl`);
  if (sibling && existsSync(sibling)) {
    emit('transcripts/background-agent.subagent.jsonl', load(sibling).slice(0, 3));
    entry.subagentFile = 'transcripts/background-agent.subagent.jsonl';
    entry.subagentId = redactor.aliases.of('agent', hit.agentId);
  }
  written.push(entry);
}

// ---- hook stdin schema ---------------------------------------------------------

// Claude Code builds hook stdin from one zod schema per event. Reading it out of the
// installed binary gives the field names, types and optionality for that exact version.
const hookEvents = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'StopFailure', 'SessionEnd'];
const hookValues = {
  session_id: '00000000-0000-4000-8000-0000000000aa', transcript_path: '/example/claude/session.jsonl', cwd: '/example/project', prompt_id: '00000000-0000-4000-8000-0000000000bb',
  permission_mode: 'default', effort: {level: 'high'}, source: null, prompt: placeholder, session_title: placeholder, model: 'claude-opus-5-5',
  tool_name: 'Bash', tool_input: {command: 'echo example'}, tool_response: {stdout: 'example', stderr: '', interrupted: false}, tool_use_id: 'toolu_fixture1', duration_ms: 12,
  permission_suggestions: [], stop_hook_active: false, last_assistant_message: placeholder, background_tasks: [], session_crons: [], reason: 'other', error: 'rate_limit', error_details: placeholder,
};
const toolEvents = ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop'];
const subagentFields = new Set(['agent_id', 'agent_type', 'mcp_server']);
function balanced(text, open) {
  const pairs = {'(': ')', '{': '}', '[': ']'};
  let depth = 0, quote = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if ('"\'`'.includes(c)) quote = c;
    else if (c in pairs) depth++;
    else if (')}]'.includes(c) && --depth === 0) return text.slice(open + 1, i);
  }
  throw Error('Unbalanced hook schema');
}
function topLevel(text, separator) {
  const parts = []; let depth = 0, quote = null, from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if ('"\'`'.includes(c)) quote = c;
    else if ('({['.includes(c)) depth++;
    else if (')}]'.includes(c)) depth--;
    else if (c === separator && depth === 0) { parts.push(text.slice(from, i)); from = i + 1; }
  }
  return [...parts, text.slice(from)].filter(Boolean);
}
const fieldsOf = body => Object.fromEntries(topLevel(body, ',').map(field => [field.slice(0, field.indexOf(':')), field.slice(field.indexOf(':') + 1)]));
function hookSchema(binary) {
  const text = readFileSync(binary, 'latin1'), version = text.match(/\/\/ Version: ([\d.]+)/)?.[1];
  const objectAt = event => { const at = text.search(new RegExp(`hook_event_name:\\w+\\("${event}"\\)`)); if (at < 0) throw Error(`Hook schema not found: ${event}`); return fieldsOf(balanced(text, text.lastIndexOf('u({', at) + 2)); };
  const base = fieldsOf(balanced(text, text.search(/u\(\{session_id:\w+\(\),transcript_path:\w+\(\),cwd:/) + 2));
  // The schema library is minified, so its type helpers are named by anchor fields of known type.
  const stop = objectAt('Stop'), post = objectAt('PostToolUse');
  const callee = expr => expr.match(/^(\w+)\(/)?.[1];
  const kinds = {[callee(base.session_id)]: 'string', [callee(stop.stop_hook_active)]: 'boolean', [callee(post.duration_ms)]: 'number', [callee(post.tool_input)]: 'unknown'};
  // A field is "type" or "type?" when optional; an enum lists its values after a colon.
  const describe = expr => {
    const calls = topLevel(expr, '.'), name = callee(calls[0]);
    const type = calls[0].startsWith(`${name}([`) ? `enum:${[...calls[0].matchAll(/"([^"]+)"/g)].map(m => m[1]).join('|')}` : calls[0].startsWith(`${name}({`) ? 'object' : kinds[name] || (calls[0].match(/^\w+\(\w+\(/) ? 'array' : 'unknown');
    return type + (calls.slice(1).some(call => call.startsWith('optional(')) ? '?' : '');
  };
  const describeAll = fields => Object.fromEntries(Object.entries(fields).map(([name, expr]) => [name, describe(expr)]));
  const events = {};
  for (const event of hookEvents) {
    const specific = objectAt(event);
    delete specific.hook_event_name;
    events[event] = {...describeAll(base), ...describeAll(specific)};
  }
  return {version, events};
}
function binaryFor(version) {
  const wanted = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code', version);
  if (existsSync(wanted)) for (const dir of readdirSync(wanted)) { const path = join(wanted, dir, 'claude.app', 'Contents', 'MacOS', 'claude'); if (existsSync(path)) return path; }
  const local = join(homedir(), '.local', 'share', 'claude', 'versions', version);
  return existsSync(local) ? local : null;
}
const binary = option('--binary', binaryFor(wantedVersion));
if (!binary) throw Error(`No Claude Code ${wantedVersion} binary found for the hook schema. Pass --binary PATH.`);
const {version, events} = hookSchema(binary);
if (version !== wantedVersion) throw Error(`The binary is Claude Code ${version}, but the transcripts are ${wantedVersion}.`);
const examples = {};
for (const [event, fields] of Object.entries(events)) {
  examples[event] = {hook_event_name: event};
  for (const [name, field] of Object.entries(fields)) {
    if (name === 'effort' && !toolEvents.includes(event) || subagentFields.has(name) || field.endsWith('?') && !(name in hookValues)) continue;
    const value = name === 'source' ? field.split('?')[0].split(':')[1].split('|')[0] : hookValues[name];
    if (value === undefined || value === null) throw Error(`No example value for ${event}.${name}`);
    examples[event][name] = value;
  }
  for (const [name, field] of Object.entries(fields)) if (!field.endsWith('?') && !(name in examples[event])) throw Error(`${event}.${name} missing from example`);
}
const hooks = {claudeCodeVersion: version, source: 'schema embedded in the Claude Code binary (the code that builds hook stdin); not recorded stdin',
  events: Object.fromEntries(Object.entries(events).map(([event, fields]) => [event, {fields, example: examples[event]}]))};
outputs.set('hooks.json', JSON.stringify(hooks, null, 1) + '\n');
outputs.set('manifest.json', JSON.stringify({recordedBy: 'scripts/record-claude-samples.mjs', transcripts: written, hooks: {file: 'hooks.json', claudeCodeVersion: version, source: hooks.source}}, null, 1) + '\n');

const check = denylist(sources);
for (const text of outputs.values()) check(text);
rmSync(out, {recursive: true, force: true});
for (const [relative, text] of outputs) {
  mkdirSync(dirname(join(out, relative)), {recursive: true});
  writeFileSync(join(out, relative), text);
}
console.log(`Wrote ${written.length} transcript samples and hooks.json for Claude Code ${version} to ${out}`);
