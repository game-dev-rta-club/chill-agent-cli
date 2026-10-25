import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandLineArgument, taskName, taskXml, windowsWebService } from '../lib/web-service-windows.mjs';

test('Windows task arguments survive spaces, quotes, trailing backslashes and Japanese', () => {
  assert.equal(commandLineArgument('C:\\plain\\chill.mjs'), 'C:\\plain\\chill.mjs');
  assert.equal(commandLineArgument('C:\\日本語 フォルダ\\service.json'), '"C:\\日本語 フォルダ\\service.json"');
  assert.equal(commandLineArgument('say "hi"'), '"say \\"hi\\""');
  assert.equal(commandLineArgument('C:\\dir with space\\'), '"C:\\dir with space\\\\"');
  assert.equal(commandLineArgument(''), '""');
});

test('a Web task has no trigger, runs without elevation and never times out', () => {
  const task = taskXml({ command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\a b\\chill-web-task.mjs', 'C:\\データ\\service.json'], cwd: 'C:\\a & b' });
  assert.doesNotMatch(task, /<Triggers>/);
  assert.match(task, /<LogonType>InteractiveToken<\/LogonType><RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(task, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(task, /<Arguments>&quot;C:\\a b\\chill-web-task\.mjs&quot; C:\\データ\\service\.json<\/Arguments>/);
  assert.match(task, /<WorkingDirectory>C:\\a &amp; b<\/WorkingDirectory>/);
});

test('each data directory has its own task in the chill-agent folder', () => {
  assert.match(taskName('C:\\Users\\me\\.chill-agent\\projects\\one'), /^\\chill-agent\\web-[0-9a-f]{12}$/);
  assert.notEqual(taskName('C:\\one'), taskName('C:\\two'));
});

test('a Web task starts Node through a headless console host, so no window opens', async t => {
  const runtime = await mkdtemp(join(tmpdir(), 'chill-web-service-'));t.after(() => rm(runtime, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const calls = [];
  const service = windowsWebService({ directory: runtime, runtime, log: join(runtime, 'server.log'), execute: async (...args) => { calls.push(args); return { stdout: '' }; } });
  await service.start({ node: 'C:\\Program Files\\nodejs\\node.exe', entry: join(runtime, 'server.mjs'), args: ['--idle-timeout', '3d'], env: { PORT: '4173' }, cwd: runtime });
  const task = (await readFile(join(runtime, 'task.xml'), 'utf16le')).replace(/^\ufeff/, '');
  assert.match(task, /<Command>[^<]*\\System32\\conhost\.exe<\/Command>/);
  assert.match(task, /<Arguments>--headless &quot;C:\\Program Files\\nodejs\\node\.exe&quot; /);
  assert.deepEqual(calls.map(([file, args]) => [file, args[0]]), [['schtasks', '/Create'], ['schtasks', '/Run']]);
  const saved = JSON.parse(await readFile(join(runtime, 'service.json'), 'utf8'));
  assert.equal(saved.env.CHILL_AGENT_SERVICE_TOKEN, saved.token);
});
