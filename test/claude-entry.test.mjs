import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {captureClaudeEntry, identifyClaudeCaller} from '../lib/claude-entry.mjs';
import {fileURLToPath} from 'node:url';
import {claudeHook,subagentHook} from './claude-fixtures.mjs';

const execute = promisify(execFile);
// The test may itself run inside Claude Code, which names its own session.
const {CLAUDE_CODE_SESSION_ID:_, ...shellEnv} = process.env;
const entry = fileURLToPath(new URL('../bin/chill-connection.mjs',import.meta.url));
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'chill-claude-test-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const cwd = join(directory, 'project'), data = join(directory, 'data');
  await mkdir(cwd);
  const envFile = join(directory, 'native env');
  await writeFile(envFile, "export EXISTING_HOOK_VALUE='preserved'\n");
  const options = {directory:data, cwd, env:{CLAUDE_ENV_FILE:envFile}};
  const input = claudeHook('SessionStart', {session_id:'native/session', source:'startup', cwd, transcript_path:'/must/not/read', prompt:'private prompt', model:'unverified-model'});
  const caller = record => ({directory:data, env:{CHILL_AGENT_HARNESS:record.harnessId,
    CHILL_AGENT_SESSION_ID:record.sessionId, CHILL_AGENT_CONNECTION_GENERATION:record.generation}});
  return {directory, data, cwd, envFile, options, input, caller};
}

test('native entry reaches the CLI through shell exports, without Goal assignment or controls', {skip:process.platform === 'win32'}, async t => {
  const f = await fixture(t), record = await captureClaudeEntry(f.input, f.options);
  const {stdout} = await execute('/bin/sh', ['-c', '. "$1"; test "$EXISTING_HOOK_VALUE" = preserved || exit 1; exec "$2" "$3" show',
    'chill-test', f.envFile, process.execPath, entry], {cwd:f.cwd, env:{...shellEnv, CHILL_AGENT_DATA_DIR:f.data}});
  const result = JSON.parse(stdout);
  assert.deepEqual(result.identity, {harnessId:'claude-code', sessionId:f.input.session_id, generation:record.generation});
  assert.deepEqual(result.roots, [], 'an entry alone owns no Goal');
  assert.doesNotMatch(JSON.stringify(record), /transcript|prompt|unverified-model|turnId|threadId/);
  assert.deepEqual(await readdir(join(f.data, 'workspace')), ['connections','coordination.sqlite']);
  const files = await readdir(join(f.data, 'workspace/connections/claude-code'));
  assert.equal(files.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length, 1);
});

test('opaque native IDs cannot traverse paths or inject shell commands', {skip:process.platform === 'win32'}, async t => {
  const f = await fixture(t);
  f.input.session_id = "../../a'$(printf injected)'`echo injected`";
  const record = await captureClaudeEntry(f.input, f.options);
  const {stdout} = await execute('/bin/sh', ['-c', '. "$1"; exec "$2" "$3" show',
    'chill-test', f.envFile, process.execPath, entry], {env:{...shellEnv, CHILL_AGENT_DATA_DIR:f.data}});
  assert.equal(JSON.parse(stdout).identity.sessionId, record.sessionId);
  assert.equal((await readdir(join(f.data, 'workspace/connections/claude-code'))).filter(name => name.endsWith('.json')).length, 1);
});

test('same-directory sessions and inherited fork environments cannot borrow identities', async t => {
  const f = await fixture(t);
  const first = await captureClaudeEntry(f.input, f.options);
  const second = await captureClaudeEntry({...f.input, session_id:'different', source:'fork'}, f.options);
  assert.notEqual(first.generation, second.generation);
  assert.equal((await identifyClaudeCaller(f.caller(first))).identity.sessionId, first.sessionId);
  // A fork can inherit the parent's exports; Claude's own session ID decides.
  const inherited = f.caller(first); inherited.env.CLAUDE_CODE_SESSION_ID = second.sessionId;
  assert.equal((await identifyClaudeCaller(inherited)).identity.sessionId, second.sessionId);
  await assert.rejects(identifyClaudeCaller({directory:f.data, env:{CODEX_THREAD_ID:first.sessionId}}), /No Claude/);
});

test('after resume, clear or compact a shell resolves to the current record, never a stale one', async t => {
  const f = await fixture(t);
  let previous = await captureClaudeEntry(f.input, f.options);
  for (const source of ['resume', 'clear', 'compact']) {
    const current = await captureClaudeEntry({...f.input, source}, f.options);
    // A command written with an earlier export still reaches the current entry.
    const caller = await identifyClaudeCaller(f.caller(previous));
    assert.equal(caller.identity.generation, current.generation);assert.equal(caller.source, source);assert.equal(caller.contextId, current.contextId);
    previous = current;
  }
  const starts = await Promise.all([captureClaudeEntry(f.input, f.options), captureClaudeEntry(f.input, f.options)]);
  const results = await Promise.all(starts.map(record => identifyClaudeCaller(f.caller(record))));
  assert.equal(new Set(results.map(r => r.identity.generation)).size, 1, 'concurrent starts settle on one current entry');
});

test('subagent or non-start hooks cannot consume feedback or replace a registration', async t => {
  const f = await fixture(t), record = await captureClaudeEntry(f.input, f.options);
  for (const input of [subagentHook('SessionStart', f.input), {...f.input, agent_id:''}, claudeHook('PostToolUse', {session_id:f.input.session_id}), claudeHook('SessionEnd', {session_id:f.input.session_id}), {...f.input, hook_event_name:'Setup'}])
    assert.equal(await captureClaudeEntry(input, f.options), null);
  assert.equal((await identifyClaudeCaller(f.caller(record))).identity.generation, record.generation);
});

test('incomplete input and failed exports never establish identity; the export file is optional', async t => {
  const f = await fixture(t);
  for (const patch of [{session_id:null}, {session_id:'\nx'}, {source:'unknown'}])
    await assert.rejects(captureClaudeEntry({...f.input, ...patch}, f.options));
  // Claude Code names the conversation in every shell, so the handoff file is a convenience.
  assert.equal((await captureClaudeEntry(f.input, {...f.options, env:{}})).sessionId, f.input.session_id);
  // A hook input naming another directory, such as a worktree, still connects.
  assert.equal((await captureClaudeEntry({...f.input, cwd:tmpdir()}, f.options)).sessionId, f.input.session_id);
  const first = await captureClaudeEntry(f.input, f.options);
  await assert.rejects(captureClaudeEntry(f.input, {...f.options, env:{CLAUDE_ENV_FILE:f.cwd}}));
  assert.equal((await identifyClaudeCaller(f.caller(first))).identity.generation, first.generation);
  await assert.rejects(identifyClaudeCaller({...f.caller(first), directory:join(f.directory, 'other')}), /not connected/);
  const missing = f.caller(first); delete missing.env.CHILL_AGENT_CONNECTION_GENERATION;
  assert.equal((await identifyClaudeCaller(missing)).identity.generation, first.generation, 'no generation is needed from the shell');
});

test('record mismatch and an interrupted export cannot identify a caller', async t => {
  const f = await fixture(t), record = await captureClaudeEntry(f.input, f.options);
  const folder = join(f.data, 'workspace/connections/claude-code');
  const path = join(folder, (await readdir(folder)).find(name => name.endsWith('.json')));
  for (const patch of [{harnessId:'codex-desktop'}, {sessionId:'elsewhere'}, {version:2}]) {
    await writeFile(path, JSON.stringify({...record, ...patch}));
    await assert.rejects(identifyClaudeCaller(f.caller(record)), /not connected/);
  }
  await rm(path);
  assert.doesNotMatch(await readFile(f.envFile, 'utf8'), /CHILL_AGENT_CONNECTION_GENERATION/, 'agents never carry the generation');
  await assert.rejects(identifyClaudeCaller(f.caller(record)), /not connected/);
});
