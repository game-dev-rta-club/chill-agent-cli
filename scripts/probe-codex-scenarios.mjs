// The `scenarios` part of scripts/probe-codex.mjs: every user-visible flow of test/harness-scenarios.test.mjs, run on
// the installed Codex app-server standing in for Desktop, with chill's real hooks and a scripted model (no cost).
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export async function runScenarios({codex, log}) {
  const child = spawn(process.execPath, ['--import', './test/isolate-env.mjs', '--test', '--test-reporter=tap', 'test/harness-scenarios.test.mjs'],
    {cwd: root, env: {...process.env, CHILL_SCENARIO_CODEX: codex.path}, stdio: ['ignore', 'pipe', 'pipe']});
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise(resolve => child.on('close', resolve));
  const checks = [...output.matchAll(/^(not )?ok \d+ - (.+)$/gm)].map(([, failed, name]) => ({name, ok: !failed}));
  for (const check of checks) log(`${check.ok ? 'pass' : 'FAIL'}  ${check.name}`);
  if (!checks.length || code !== 0 && checks.every(check => check.ok)) checks.push({name: 'the scenarios ran', ok: false, detail: output.slice(-2000)});
  return {checks};
}
