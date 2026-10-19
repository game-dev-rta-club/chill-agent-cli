import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {userInfo, tmpdir} from 'node:os';
import {join, relative, isAbsolute} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {withDesktopIPC} from '../lib/desktop-settings.mjs';
import {resolveCodex} from '../lib/codex-client.mjs';
import {dataDirectory} from '../lib/data-directory.mjs';
import {hidden, recordHidden} from '../lib/hidden-failure.mjs';
import {expectHidden} from './hidden-failures.mjs';

const exec = promisify(execFile);
const inside = (parent, path) => { const r = relative(parent, path); return r !== '' && !r.startsWith('..') && !isAbsolute(r); };

test('tests run in a throwaway home, so no default path reaches the real Codex, Claude or data', async () => {
  const home = process.env.HOME;
  assert.notEqual(home, userInfo().homedir);
  const socket = await withDesktopIPC(() => {}, {platform: 'darwin'}).catch(error => error.path);
  assert.ok(inside(home, socket), `Desktop IPC probes ${socket}`);
  assert.ok(inside(home, dataDirectory()), `data lives in ${dataDirectory()}`);
  await assert.rejects(resolveCodex(), /Desktop Codex not found/);
});

test('a recorded hidden failure is one JSON line with its site and message, and does nothing without the file', async t => {
  expectHidden(t, 'test-environment.sample');
  const file = process.env.CHILL_AGENT_HIDDEN_FAILURES, before = (await readFile(file, 'utf8')).split('\n').filter(Boolean).length;
  assert.equal(await Promise.reject(Error('boom')).catch(hidden('test-environment.sample', 'fallback')), 'fallback');
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean).slice(before).map(JSON.parse);
  assert.deepEqual(lines, [{where: 'test-environment.sample', message: 'boom'}]);
  const saved = process.env.CHILL_AGENT_HIDDEN_FAILURES;
  delete process.env.CHILL_AGENT_HIDDEN_FAILURES;
  try { recordHidden('test-environment.silent', Error('ignored')); } finally { process.env.CHILL_AGENT_HIDDEN_FAILURES = saved; }
  assert.equal((await readFile(file, 'utf8')).split('\n').filter(Boolean).length, before + 1);
});

test('a test fails on an undeclared hidden failure and on a declaration that never happened', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hidden-fixture-'));
  const run = async body => {
    const file = join(dir, `case-${Math.random().toString(36).slice(2)}.test.mjs`);
    await writeFile(file, `import test from 'node:test';import {recordHidden} from ${JSON.stringify(import.meta.resolve('../lib/hidden-failure.mjs'))};import {expectHidden} from ${JSON.stringify(import.meta.resolve('./hidden-failures.mjs'))};test('case',t=>{${body}});`);
    const {NODE_TEST_CONTEXT, ...env} = process.env;
    return exec(process.execPath, ['--import', import.meta.resolve('./isolate-env.mjs'), '--test', file], {env}).then(r => ({code: 0, out: r.stdout}), e => ({code: e.code, out: e.stdout}));
  };
  const declared = await run("expectHidden(t,'fixture.site');recordHidden('fixture.site',Error('boom'));");
  assert.equal(declared.code, 0, declared.out);
  const undeclared = await run("recordHidden('fixture.site',Error('boom'));");
  assert.notEqual(undeclared.code, 0);
  assert.match(undeclared.out, /undeclared hidden failure fixture\.site: boom/);
  const unseen = await run("expectHidden(t,'fixture.site');");
  assert.notEqual(unseen.code, 0);
  assert.match(unseen.out, /expectHidden\(fixture\.site\) never happened/);
  const pattern = await run("expectHidden(t,/^fixture\\./);recordHidden('fixture.other',Error('x'));");
  assert.equal(pattern.code, 0, pattern.out);
});
