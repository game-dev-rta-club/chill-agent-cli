import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {captureClaudeEntry, identifyClaudeCaller} from '../lib/claude-entry.mjs';

const execute = promisify(execFile);
const entry = new URL('../bin/chill-connection.mjs', import.meta.url).pathname;
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'chill-claude-test-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const cwd = join(directory, 'project'), data = join(directory, 'data');
  await mkdir(cwd);
  const envFile = join(directory, 'native env');
  await writeFile(envFile, "export EXISTING_HOOK_VALUE='preserved'\n");
  const options = {directory:data, cwd, env:{CLAUDE_ENV_FILE:envFile}};
  const input = {hook_event_name:'SessionStart', session_id:'native/session', source:'startup', cwd,
    transcript_path:'/must/not/read', prompt:'private prompt', model:'unverified-model'};
  const caller = record => ({directory:data, env:{CHILL_AGENT_HARNESS:record.harnessId,
    CHILL_AGENT_SESSION_ID:record.sessionId, CHILL_AGENT_CONNECTION_GENERATION:record.generation}});
  return {directory, data, cwd, envFile, options, input, caller};
}

test('native entry reaches the CLI through shell exports, without Goal assignment or controls', {skip:process.platform === 'win32'}, async t => {
  const f = await fixture(t), record = await captureClaudeEntry(f.input, f.options);
  const {stdout} = await execute('/bin/sh', ['-c', '. "$1"; test "$EXISTING_HOOK_VALUE" = preserved || exit 1; exec "$2" "$3" show',
    'chill-test', f.envFile, process.execPath, entry], {cwd:f.cwd, env:{...process.env, CHILL_AGENT_DATA_DIR:f.data}});
  const result = JSON.parse(stdout);
  assert.deepEqual(result.identity, {harnessId:'claude-code', sessionId:f.input.session_id, generation:record.generation});
  assert.equal(result.stage, 'entry-only');
  assert(Object.values(result.capabilities).every(value => value === false));
  assert.doesNotMatch(JSON.stringify(record), /transcript|prompt|unverified-model|turnId|threadId/);
  assert.deepEqual(await readdir(join(f.data, 'workspace')), ['connections']);
  const files = await readdir(join(f.data, 'workspace/connections/claude-code'));
  assert.equal(files.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length, 1);
});

test('opaque native IDs cannot traverse paths or inject shell commands', {skip:process.platform === 'win32'}, async t => {
  const f = await fixture(t);
  f.input.session_id = "../../a'$(printf injected)'`echo injected`";
  const record = await captureClaudeEntry(f.input, f.options);
  const {stdout} = await execute('/bin/sh', ['-c', '. "$1"; exec "$2" "$3" show',
    'chill-test', f.envFile, process.execPath, entry], {env:{...process.env, CHILL_AGENT_DATA_DIR:f.data}});
  assert.equal(JSON.parse(stdout).identity.sessionId, record.sessionId);
  assert.equal((await readdir(join(f.data, 'workspace/connections/claude-code'))).filter(name => name.endsWith('.json')).length, 1);
});

test('same-directory sessions and inherited fork environments cannot borrow identities', async t => {
  const f = await fixture(t);
  const first = await captureClaudeEntry(f.input, f.options);
  const second = await captureClaudeEntry({...f.input, session_id:'different', source:'fork'}, f.options);
  assert.notEqual(first.generation, second.generation);
  assert.equal((await identifyClaudeCaller(f.caller(first))).identity.sessionId, first.sessionId);
  const mixed = f.caller(first); mixed.env.CHILL_AGENT_SESSION_ID = second.sessionId;
  await assert.rejects(identifyClaudeCaller(mixed), /stale/);
  await assert.rejects(identifyClaudeCaller({directory:f.data, env:{CODEX_THREAD_ID:first.sessionId}}), /No Claude/);
});

test('resume, clear and compact invalidate earlier generations, including concurrent starts', async t => {
  const f = await fixture(t);
  let previous = await captureClaudeEntry(f.input, f.options);
  for (const source of ['resume', 'clear', 'compact']) {
    const current = await captureClaudeEntry({...f.input, source}, f.options);
    await assert.rejects(identifyClaudeCaller(f.caller(previous)), /stale/);
    assert.equal((await identifyClaudeCaller(f.caller(current))).source, source);
    previous = current;
  }
  const starts = await Promise.all([captureClaudeEntry(f.input, f.options), captureClaudeEntry(f.input, f.options)]);
  const results = await Promise.allSettled(starts.map(record => identifyClaudeCaller(f.caller(record))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  await assert.rejects(identifyClaudeCaller(f.caller(previous)), /stale/);
});

test('subagent or non-start hooks cannot consume feedback or replace a registration', async t => {
  const f = await fixture(t), record = await captureClaudeEntry(f.input, f.options);
  for (const patch of [{agent_id:'child'}, {agent_id:''}, {hook_event_name:'PostToolUse'}, {hook_event_name:'SessionEnd'}, {hook_event_name:'Setup'}])
    assert.equal(await captureClaudeEntry({...f.input, ...patch}, f.options), null);
  assert.equal((await identifyClaudeCaller(f.caller(record))).identity.generation, record.generation);
});

test('incomplete input, wrong directory and failed exports never establish identity', async t => {
  const f = await fixture(t);
  for (const patch of [{session_id:null}, {session_id:'\nx'}, {source:'unknown'}, {cwd:tmpdir()}])
    await assert.rejects(captureClaudeEntry({...f.input, ...patch}, f.options));
  await assert.rejects(captureClaudeEntry(f.input, {...f.options, env:{}}), /handoff/);
  const first = await captureClaudeEntry(f.input, f.options);
  await assert.rejects(captureClaudeEntry(f.input, {...f.options, env:{CLAUDE_ENV_FILE:f.cwd}}));
  assert.equal((await identifyClaudeCaller(f.caller(first))).identity.generation, first.generation);
  await assert.rejects(identifyClaudeCaller({...f.caller(first), directory:join(f.directory, 'other')}), /stale/);
  const missing = f.caller(first); delete missing.env.CHILL_AGENT_CONNECTION_GENERATION;
  await assert.rejects(identifyClaudeCaller(missing), /generation/);
});

test('record mismatch and an interrupted export cannot identify a caller', async t => {
  const f = await fixture(t), record = await captureClaudeEntry(f.input, f.options);
  const folder = join(f.data, 'workspace/connections/claude-code');
  const path = join(folder, (await readdir(folder)).find(name => name.endsWith('.json')));
  for (const patch of [{harnessId:'codex-desktop'}, {sessionId:'elsewhere'}, {version:2}]) {
    await writeFile(path, JSON.stringify({...record, ...patch}));
    await assert.rejects(identifyClaudeCaller(f.caller(record)), /stale/);
  }
  await rm(path);
  assert.match(await readFile(f.envFile, 'utf8'), /CHILL_AGENT_CONNECTION_GENERATION/);
  await assert.rejects(identifyClaudeCaller(f.caller(record)), /stale/);
});
