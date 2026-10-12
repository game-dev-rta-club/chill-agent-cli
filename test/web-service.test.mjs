import test from 'node:test';
import assert from 'node:assert/strict';
import { commandLineArgument, taskName, taskXml } from '../lib/web-service-windows.mjs';

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
