import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {claudeModel, claudeRunning, claudeTurn, claudeWork} from '../lib/claude-transcript.mjs';
import {captureClaudeEntry} from '../lib/claude-entry.mjs';
import {claudeRmGuard} from '../lib/claude-rm-guard.mjs';
import {claudeEntry, claudeHook, claudeLines, hookFor, hookSchema, manifest, recorded, recordedText} from './claude-fixtures.mjs';

// What chill reads from Claude Code, checked against what Claude Code is recorded
// sending. The hook fields come from the hook input schema of the same release
// (not recorded stdin); the transcript entries are redacted real lines. See
// docs/development/claude-contract.md for how to record them again.
const version = manifest.transcripts[0].claudeCodeVersion;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = async file => readFile(join(root, file), 'utf8');

const hookReads = {
  SessionStart: {session_id: 'string', transcript_path: 'string', source: 'enum', agent_id: 'string?'},
  UserPromptSubmit: {session_id: 'string', transcript_path: 'string', agent_id: 'string?'},
  SessionEnd: {session_id: 'string', transcript_path: 'string', agent_id: 'string?'},
  PreToolUse: {session_id: 'string', tool_name: 'string', tool_input: 'unknown'},
  PermissionRequest: {session_id: 'string', tool_name: 'string'},
  PostToolUse: {session_id: 'string', tool_name: 'string', tool_response: 'unknown', agent_id: 'string?'},
  Stop: {session_id: 'string', transcript_path: 'string', stop_hook_active: 'boolean', prompt_id: 'string?', agent_id: 'string?', background_tasks: 'array?'},
};
const hookFiles = ['lib/claude-entry.mjs', 'lib/claude-actions.mjs', 'lib/claude-pause.mjs', 'lib/claude-permissions.mjs', 'lib/claude-rm-guard.mjs', 'bin/chill-connection.mjs'];

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
  ['assistant tool call', e => e.type === 'assistant' && hasPart('tool_use')(e), {'message.content[tool_use].id': 'string', 'message.content[tool_use].name': 'string', 'message.content[tool_use].input': 'object'}],
  ['background Agent launch', e => e.type === 'assistant' && content(e).some(p => p.type === 'tool_use' && p.name === 'Agent'), {'message.content[tool_use].input.run_in_background': 'true'}],
  ['user prompt', e => e.type === 'user' && typeof e.message?.content === 'string' && !e.isMeta && !e.message.content.startsWith('<'), {uuid: 'string', timestamp: 'string', 'message.content': 'string', isSidechain: 'boolean'}],
  ['tool result', e => e.type === 'user' && !!e.toolUseResult && hasPart('tool_result')(e), {toolUseResult: 'truthy', 'message.content[tool_result].tool_use_id': 'string'}],
  ['Agent launch result', e => e.type === 'user' && !!e.toolUseResult && /agentId: \w+/.test(raw(e)), {'message.content[tool_result].content[0].text': /agentId: \w+/}],
  ['interrupt', e => e.type === 'user' && content(e).some(p => p.text?.startsWith('[Request interrupted')), {'message.content[text].text': /^\[Request interrupted by user( for tool use)?\]$/}],
  ['Stop summary', e => e.type === 'system' && e.subtype === 'stop_hook_summary', {uuid: 'string', timestamp: 'string', isSidechain: 'boolean'}],
  ['hook feedback offer', e => e.type === 'attachment' && e.attachment?.type === 'hook_additional_context', {'attachment.content[0]': 'string', $: /\\"offerId\\":\\"[0-9a-f-]{36}/}],
  ['Auto mode request message', e => e.type === 'user' && e.isMeta === true, {'message.content': /--attempt [0-9a-f-]{36}/, isMeta: 'true'}],
  ['queued task notification', e => e.type === 'queue-operation' && typeof e.content === 'string', {operation: 'string', content: /<task-notification>[\s\S]*<task-id>\w+<\/task-id>/}],
  ['task notification message', e => e.type === 'user' && typeof e.message?.content === 'string' && e.message.content.startsWith('<task-notification>'), {'message.content': /<task-id>\w+<\/task-id>/}],
  ['task notification attachment', e => e.attachment?.type === 'queued_command', {'attachment.prompt': /<task-notification>[\s\S]*<task-id>\w+<\/task-id>/}],
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
  const text = await source('lib/claude-transcript.mjs');
  for (const match of text.matchAll(/\bentry\??\.(\w+)/g)) top.add(match[1]);
  for (const match of text.matchAll(/\bentry\??\.(?:message|attachment)\??\.(\w+)/g)) nested.add(match[1]);
  const declaredNested = new Set(entryReads.flatMap(([, , fields]) => Object.keys(fields).filter(path => /^(message|attachment)\./.test(path)).map(path => path.split(/[.[]/)[1])));
  assert.deepEqual([...top].filter(field => !declared.has(field)), [], 'declare the entry field in entryReads');
  assert.deepEqual([...nested].filter(field => !declaredNested.has(field)), [], 'declare the nested entry field in entryReads');
});

async function stage(t, name, {upTo, extra = ''} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'claude-contract-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const path = join(dir, 'session.jsonl'), lines = recordedText(name).split('\n').filter(Boolean);
  await writeFile(path, lines.slice(0, upTo ?? lines.length).join('\n') + '\n' + extra);
  return {dir, path, lines};
}
const stopIndex = lines => lines.findIndex(line => JSON.parse(line).subtype === 'stop_hook_summary');

test('a recorded turn is running until its interrupt, and its model and effort are those Claude Code wrote', async t => {
  const open = await stage(t, 'interrupted-turn', {upTo: 3});
  assert.equal(await claudeRunning(open.path), true, 'prompt and reasoning, no end yet');
  const written = recorded['interrupted-turn'].findLast(entry => entry.type === 'assistant');
  assert.deepEqual(await claudeModel(open.path), {model: written.message.model, reasoning: written.effort});
  const interrupted = await stage(t, 'interrupted-turn');
  assert.equal(await claudeRunning(interrupted.path), false);
  const turn = await claudeTurn(interrupted.path);
  assert.match(turn.turnId, /^claude:[0-9a-f-]{36}$/);
  assert.equal(await claudeRunning((await stage(t, 'tool-interrupted-turn')).path), false, 'an interrupt while a tool runs also ends the response');
  assert.equal(await claudeRunning((await stage(t, 'tool-interrupted-turn', {upTo: 3})).path), true);
});

test('feedback offered mid-turn is followed by its response until the recorded Stop', async t => {
  const full = await stage(t, 'feedback-turn'), offer = recorded['feedback-turn'].find(entry => entry.attachment?.type === 'hook_additional_context' && raw(entry).includes('offerId'));
  const offerId = JSON.parse(offer.attachment.content[0].split('\n')[1])[0].offerId;
  const index = recorded['feedback-turn'].indexOf(offer), stop = recorded['feedback-turn'].findLastIndex(entry => entry.subtype === 'stop_hook_summary');
  const spoken = recorded['feedback-turn'].slice(index, stop).filter(entry => entry.type === 'assistant' && hasPart('text')(entry));
  const work = await claudeWork(full.path, offerId);
  assert.equal(work.status, 'completed', 'the recorded Stop summary ends the response');
  assert.equal(work.endedAt, recorded['feedback-turn'][stop].timestamp, 'the end is the Stop summary timestamp');
  assert.deepEqual(work.messages.map(m => m.id), spoken.map(entry => entry.uuid), 'the public text after the offer, nothing from thinking or tools');
  const last = recorded['feedback-turn'].findLast(entry => entry.type === 'assistant');
  assert.deepEqual(work.settings, {model: last.message.model, reasoning: last.effort});
  const before = await stage(t, 'feedback-turn', {upTo: stop});
  assert.equal((await claudeWork(before.path, offerId)).status, 'working');
  assert.equal(await claudeRunning(before.path), true);
  assert.equal(await claudeWork(full.path, '00000000-0000-4000-8000-ffffffffffff'), null);
});

test('a recorded background subagent keeps its response Running until its notification arrives', async t => {
  const [sample] = manifest.transcripts.filter(s => s.name === 'background-agent');
  const lines = recordedText('background-agent').split('\n').filter(Boolean), stop = stopIndex(lines);
  const open = await stage(t, 'background-agent', {upTo: stop + 1});
  await mkdir(join(open.dir, 'session', 'subagents'), {recursive: true});
  const file = join(open.dir, 'session', 'subagents', `agent-${sample.subagentId}.jsonl`);
  await copyFile(new URL('./fixtures/claude-code/transcripts/background-agent.subagent.jsonl', import.meta.url), file);
  assert.deepEqual(await claudeTurn(open.path).then(({running, background}) => ({running, background})), {running: false, background: 1}, 'the Stop ended the response but the subagent is working');
  const old = new Date(Date.now() - 60 * 60 * 1000);
  await utimes(file, old, old);
  assert.equal((await claudeTurn(open.path)).background, 0, 'a subagent that stopped writing ended with its app');
  await utimes(file, new Date(), new Date());
  const whole = join(open.dir, 'whole.jsonl');
  await writeFile(whole, recordedText('background-agent'));
  await mkdir(join(open.dir, 'whole', 'subagents'), {recursive: true});
  await copyFile(file, join(open.dir, 'whole', 'subagents', `agent-${sample.subagentId}.jsonl`));
  assert.equal((await claudeTurn(whole)).background, 0, 'the recorded task notification ended it');
});

test('each recorded form of a task notification ends a subagent, and an interim one does not', async t => {
  const launch = [claudeEntry.prompt('p1'), claudeEntry.launchAgent('a1', 'toolu_bg'), claudeEntry.agentLaunched('r1', 'toolu_bg', 'agent77'), claudeEntry.text('a2', 'Started'), claudeEntry.stop()];
  const forms = {'queued operation': claudeEntry.notice({taskId: 'agent77', toolUseId: 'toolu_bg'}), 'user message': claudeEntry.noticeMessage('n1', 'agent77'), 'queued command attachment': claudeEntry.noticeAttachment('agent77')};
  const background = async (t, ...more) => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-contract-'));
    t.after(() => rm(dir, {recursive: true, force: true}));
    await mkdir(join(dir, 'session', 'subagents'), {recursive: true});
    await writeFile(join(dir, 'session', 'subagents', 'agent-agent77.jsonl'), '{}\n');
    await writeFile(join(dir, 'session.jsonl'), claudeLines([...launch, ...more]));
    return (await claudeTurn(join(dir, 'session.jsonl'))).background;
  };
  assert.equal(await background(t), 1);
  for (const [form, notice] of Object.entries(forms)) assert.equal(await background(t, notice), 0, `the ${form} ends the subagent`);
  assert.equal(await background(t, claudeEntry.notice({taskId: 'agent77', toolUseId: 'toolu_bg', interim: true})), 1, 'the interim notice leaves it working');
});

test('an Auto mode run is the response that followed the Stop carrying its request', async t => {
  const attempt = raw(recorded['auto-continue']).match(/--attempt ([0-9a-f-]{36})/)[1];
  const work = await claudeWork((await stage(t, 'auto-continue')).path, attempt);
  assert.ok(work.messages.length > 0, 'the response after the request is the run output');
});
