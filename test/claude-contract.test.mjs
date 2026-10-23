import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {claudeMessagesSince, claudeModel} from '../lib/claude-transcript.mjs';
import {observedClaudeWork} from '../lib/claude-agent-work.mjs';
import {idleWork} from '../lib/agent-rules.mjs';
import {captureClaudeEntry} from '../lib/claude-entry.mjs';
import {claudeRmGuard} from '../lib/claude-rm-guard.mjs';
import {claudeHook, hookFor, hookSchema, manifest, recorded, recordedText} from './claude-fixtures.mjs';

// What chill reads from Claude Code, checked against what Claude Code is recorded
// sending. The hook fields come from the hook input schema of the same release
// (not recorded stdin); the transcript entries are redacted real lines. See
// docs/development/claude-contract.md for how to record them again.
const version = manifest.transcripts[0].claudeCodeVersion;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = async file => readFile(join(root, file), 'utf8');

const hookReads = {
  SessionStart: {session_id: 'string', transcript_path: 'string', source: 'enum', agent_id: 'string?'},
  UserPromptSubmit: {session_id: 'string', transcript_path: 'string', agent_id: 'string?', prompt: 'string', source: 'enum'},
  SessionEnd: {session_id: 'string', transcript_path: 'string', agent_id: 'string?'},
  PreToolUse: {session_id: 'string', tool_name: 'string', tool_input: 'unknown', agent_id: 'string?', agent_type: 'string?'},
  PermissionRequest: {session_id: 'string', tool_name: 'string', agent_id: 'string?', agent_type: 'string?'},
  PostToolUse: {session_id: 'string', tool_name: 'string', tool_response: 'unknown', agent_id: 'string?', agent_type: 'string?'},
  Stop: {session_id: 'string', transcript_path: 'string', stop_hook_active: 'boolean', prompt_id: 'string?', agent_id: 'string?', background_tasks: 'array?', last_assistant_message: 'string?'},
  StopFailure: {session_id: 'string', agent_id: 'string?'},
  SubagentStart: {session_id: 'string', agent_id: 'string', agent_type: 'string'},
  SubagentStop: {session_id: 'string', agent_id: 'string'},
};
const hookFiles = ['lib/claude-entry.mjs', 'lib/claude-actions.mjs', 'lib/claude-pause.mjs', 'lib/claude-permissions.mjs', 'lib/claude-rm-guard.mjs', 'lib/claude-agent-work.mjs', 'bin/chill-connection.mjs'];

test('the recorded samples are one Claude Code release and carry nothing private', async () => {
  assert.equal(hookSchema.claudeCodeVersion, version, 'hooks.json and the transcripts come from different releases');
  for (const sample of manifest.transcripts) assert.equal(sample.claudeCodeVersion, version, `${sample.name} comes from another release`);
  for (const [name, entries] of Object.entries(recorded)) for (const entry of entries) {
    if (entry.version) assert.equal(entry.version, version, `${name} has a line from another release`);
    assert.doesNotMatch(JSON.stringify(entry), /\/Users\/|\/home\/|@[\w-]+\.[a-z]{2,}|\bsk-\w{20}|\bgh[ps]_\w{20}|Bearer /, `${name} carries a path, address or secret`);
  }
});

test('every hook field chill reads is sent by Claude Code with the type chill expects', () => {
  const problems = [];
  for (const [event, reads] of Object.entries(hookReads)) {
    const sent = hookSchema.events[event]?.fields;
    if (!sent) { problems.push(`${event}: Claude Code ${hookSchema.claudeCodeVersion} has no such hook`); continue; }
    for (const [field, type] of Object.entries(reads)) {
      const actual = sent[field]?.split(':')[0];
      if (actual !== type) problems.push(`${event}.${field}: chill expects ${type}, Claude Code sends ${actual ?? 'nothing'}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('a hook field chill reads is declared in the hook contract', async () => {
  const declared = new Set(['hook_event_name', ...Object.values(hookReads).flatMap(Object.keys)]);
  const read = new Set();
  for (const file of hookFiles) for (const match of (await source(file)).matchAll(/\binput\??\.([a-z]+_[a-z_]+)/g)) read.add(match[1]);
  assert.deepEqual([...read].filter(field => !declared.has(field)), [], 'declare the field in hookReads so its type is checked against the recorded hook shapes');
});

test('chill accepts every recorded hook shape, including each way a session starts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-contract-')), previous = process.env.CHILL_AGENT_DATA_DIR;
  process.env.CHILL_AGENT_DATA_DIR = join(dir, 'data');
  t.after(async () => { if (previous === undefined) delete process.env.CHILL_AGENT_DATA_DIR; else process.env.CHILL_AGENT_DATA_DIR = previous; await rm(dir, {recursive: true, force: true}); });
  const cwd = join(dir, 'project'), envFile = join(dir, 'env');
  await mkdir(cwd); await writeFile(envFile, '');
  const sources = hookSchema.events.SessionStart.fields.source.split(':')[1].split('|');
  for (const startSource of sources) {
    const record = await captureClaudeEntry(claudeHook('SessionStart', {source: startSource, session_id: `session-${startSource}`, cwd}), {cwd, env: {CLAUDE_ENV_FILE: envFile}});
    assert.equal(record.source, startSource);
    assert.equal(record.transcriptPath, claudeHook('SessionStart').transcript_path, 'the transcript path Claude Code sends is kept');
  }
  const main = hookFor({session_id: 'session-startup', cwd});
  assert.equal(claudeRmGuard(main('PreToolUse', {tool_input: {command: 'rm -f "$DIR"/*.png'}}))?.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(claudeRmGuard(main('PreToolUse', {tool_input: {command: 'ls'}})), null);
});

const content = entry => Array.isArray(entry.message?.content) ? entry.message.content : [];
const hasPart = type => entry => content(entry).some(part => part.type === type);
const raw = entry => JSON.stringify(entry);
const entryReads = [
  ['assistant text', e => e.type === 'assistant' && hasPart('text')(e), {uuid: 'string', timestamp: 'string', effort: 'string', isSidechain: 'boolean', 'message.model': 'string', 'message.content[text].text': 'string'}],
  ['task notification', e => e.type === 'queue-operation' && e.operation === 'enqueue' && String(e.content).includes('<task-notification>'), {timestamp: 'string', content: /<task-id>[^<]+<\/task-id>/}],
  ['interrupt', e => e.type === 'user' && content(e).some(p => p.text?.startsWith('[Request interrupted')), {timestamp: 'string', isSidechain: 'boolean', 'message.content[text].text': /^\[Request interrupted by user( for tool use)?\]$/}],
];
function lookup(value, path) {
  for (const step of path.split(/\.(?![^[]*\])/)) {
    const [, key, index] = step.match(/^([^[]*)(?:\[(.*)\])?$/);
    if (key) value = value?.[key];
    if (index === undefined) continue;
    value = /^\d+$/.test(index) ? value?.[Number(index)] : value?.find?.(part => part?.type === index);
  }
  return value;
}
const fits = (value, spec) => spec instanceof RegExp ? typeof value === 'string' && spec.test(value)
  : spec === 'truthy' ? !!value : spec === 'true' ? value === true : spec === 'object' ? !!value && typeof value === 'object' && !Array.isArray(value) : typeof value === spec;
const samples = Object.values(recorded).flat();

test('every transcript entry kind chill reads is in the recorded samples with the fields and types chill reads', () => {
  const problems = [];
  for (const [kind, select, fields] of entryReads) {
    const entries = samples.filter(select);
    if (!entries.length) { problems.push(`no recorded Claude Code ${version} sample of "${kind}"`); continue; }
    for (const [path, spec] of Object.entries(fields)) {
      if (!entries.some(entry => fits(path === '$' ? raw(entry) : lookup(entry, path), spec))) problems.push(`"${kind}": ${path === '$' ? 'the raw line' : path} is not ${spec instanceof RegExp ? `like ${spec}` : spec} in any recorded sample`);
    }
  }
  assert.deepEqual(problems, []);
});

test('the sidechain entries of a recorded subagent are marked, and chill reads nothing of them', async () => {
  const text = await readFile(new URL('./fixtures/claude-code/transcripts/background-agent.subagent.jsonl', import.meta.url), 'utf8');
  assert.ok(text.trim().split('\n').every(line => JSON.parse(line).isSidechain === true));
});

test('a transcript field chill reads is declared in the entry contract', async () => {
  const declared = new Set(['type', 'subtype', 'operation', ...entryReads.flatMap(([, , fields]) => Object.keys(fields).map(path => path.split(/[.[]/)[0]))]);
  const top = new Set(), nested = new Set();
  const text = (await source('lib/claude-transcript.mjs')) + (await source('lib/claude-agent-work.mjs'));
  for (const match of text.matchAll(/(?<![-\w])entry\??\.(\w+)/g)) top.add(match[1]);
  for (const match of text.matchAll(/\bentry\??\.(?:message|attachment)\??\.(\w+)/g)) nested.add(match[1]);
  const declaredNested = new Set(entryReads.flatMap(([, , fields]) => Object.keys(fields).filter(path => /^(message|attachment)\./.test(path)).map(path => path.split(/[.[]/)[1])));
  assert.deepEqual([...top].filter(field => !declared.has(field)), [], 'declare the entry field in entryReads');
  assert.deepEqual([...nested].filter(field => !declaredNested.has(field)), [], 'declare the nested entry field in entryReads');
});

async function stage(t, name, {upTo} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'claude-contract-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const path = join(dir, 'session.jsonl'), lines = recordedText(name).split('\n').filter(Boolean);
  await writeFile(path, lines.slice(0, upTo ?? lines.length).join('\n') + '\n');
  return path;
}

test('the model and effort are those Claude Code wrote, and an Esc interrupt it recorded ends the work', async t => {
  const written = recorded['interrupted-turn'].findLast(entry => entry.type === 'assistant');
  assert.deepEqual(await claudeModel(await stage(t, 'interrupted-turn')), {model: written.message.model, reasoning: written.effort});
  for (const name of ['interrupted-turn', 'tool-interrupted-turn']) {
    const startedAt = recorded[name][0].timestamp, record = path => ({transcriptPath: path, agentWork: {...idleWork, phase: 'working', id: 'w', startedAt}});
    assert.equal((await observedClaudeWork(record(await stage(t, name)))).work.phase, 'interrupted', `${name}: the recorded interrupt`);
    assert.equal((await observedClaudeWork(record(await stage(t, name, {upTo: 3})))).work.phase, 'working', `${name}: before its interrupt`);
  }
});

test('the Think of a stretch of work is the public text written since it started', async t => {
  const entries = recorded['feedback-turn'], offer = entries.findIndex(entry => entry.attachment?.type === 'hook_additional_context');
  const since = entries[offer].timestamp;
  const spoken = entries.filter(entry => entry.type === 'assistant' && !entry.isSidechain && hasPart('text')(entry) && Date.parse(entry.timestamp) >= Date.parse(since));
  const {messages, settings} = await claudeMessagesSince(await stage(t, 'feedback-turn'), since);
  assert.ok(spoken.length > 0);
  assert.deepEqual(messages.map(m => m.id), spoken.map(entry => entry.uuid), 'public text only, nothing from thinking or tools');
  const last = entries.findLast(entry => entry.type === 'assistant');
  assert.deepEqual(settings, {model: last.message.model, reasoning: last.effort});
});
