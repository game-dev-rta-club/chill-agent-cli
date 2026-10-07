#!/usr/bin/env node
// Qualify startup hook input without starting a model conversation or installing hooks.
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const { values } = parseArgs({ options: {
  claude: { type: 'string', default: 'claude' },
  handshake: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('Usage: node scripts/probe-claude-entry.mjs [--claude /path/to/claude] [--handshake]\nRuns two isolated --init-only invocations and prints a JSON report. --handshake also qualifies the environment handoff into connection show. Never starts a conversation.');
  process.exit(0);
}

const run = promisify(execFile);
const sandbox = await mkdtemp(join(tmpdir(), 'chill-claude-entry-'));
const config = join(sandbox, 'config');
const workspace = join(sandbox, 'workspace');
const capture = join(sandbox, 'capture.mjs');
const settings = join(sandbox, 'settings.json');
const env = {};
for (const name of ['PATH', 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'SYSTEMROOT']) {
  if (process.env[name] !== undefined) env[name] = process.env[name];
}
Object.assign(env, {
  CLAUDE_CONFIG_DIR: config,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
  CHILL_AGENT_DATA_DIR: join(sandbox, 'chill-data'),
});

const report = {
  checkedAt: new Date().toISOString(),
  mode: 'init-only',
  handshake:values.handshake,
  scope: 'Startup hooks only; no authentication, feedback, idle wake or model-control qualification.',
  runs: [],
};
let phase = 'prepare';
try {
  await mkdir(config);
  await mkdir(workspace);
  await writeFile(capture, `import { appendFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 65536) throw new Error('Hook input too large');
  chunks.push(chunk);
}
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const text = key => typeof input[key] === 'string' ? input[key].slice(0, 512) : null;
const snapshot = {
  fields: Object.keys(input).sort(),
  event: text('hook_event_name'), sessionId: text('session_id'),
  source: text('source'), trigger: text('trigger'), model: text('model'),
  promptIdPresent: Object.hasOwn(input, 'prompt_id'),
  turnIdPresent: Object.hasOwn(input, 'turn_id'),
  agentIdPresent: Object.hasOwn(input, 'agent_id'),
  cwdMatches: typeof input.cwd === 'string' && realpathSync(input.cwd) === realpathSync(process.cwd()),
};
if (${values.handshake} && input.hook_event_name === 'SessionStart') {
  execFileSync(process.execPath, [${JSON.stringify(new URL('../bin/chill-connection.mjs', import.meta.url).pathname)}, 'claude-hook'],
    { input:JSON.stringify(input), encoding:'utf8', timeout:5000 });
  const result = JSON.parse(execFileSync('/bin/sh', ['-c', '. "$1"; exec "$2" "$3" show', 'chill-entry-probe',
    process.env.CLAUDE_ENV_FILE, process.execPath, ${JSON.stringify(new URL('../bin/chill-connection.mjs', import.meta.url).pathname)}], { encoding:'utf8', timeout:5000 }));
  snapshot.handshake = { sameSession:result.identity.sessionId === input.session_id,
    generationVerified:typeof result.identity.generation === 'string' && result.identity.generation.length === 36,
    entryOnly:result.stage === 'entry-only' && Object.values(result.capabilities).every(value => value === false) };
}
appendFileSync(process.argv[2], JSON.stringify(snapshot) + '\\n', { mode: 0o600 });
`);
  const options = { cwd: workspace, env, timeout: 30000, maxBuffer: 65536 };
  phase = 'version';
  const version = await run(values.claude, ['--version'], options);
  report.version = version.stdout.trim();
  for (let index = 0; index < 2; index++) {
    const output = join(sandbox, `events-${index}.jsonl`);
    const hook = { type: 'command', command: process.execPath, args: [capture, output], timeout: 5 };
    await writeFile(settings, JSON.stringify({ hooks: {
      Setup: [{ matcher: 'init', hooks: [hook] }],
      SessionStart: [{ matcher: 'startup', hooks: [hook] }],
    } }));
    phase = `startup-${index + 1}`;
    const result = await run(values.claude, [
      '--init-only', '--setting-sources', '', '--settings', settings,
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--no-chrome',
    ], options);
    phase = `capture-${index + 1}`;
    const events = (await readFile(output, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    report.runs.push({ events, stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr) });
  }
  const ids = report.runs.map(({ events }) => events.find(event => event.event === 'SessionStart')?.sessionId);
  report.checks = {
    bothStartupHooks: report.runs.every(({ events }) => events.length === 2
      && events.some(event => event.event === 'Setup' && event.trigger === 'init')
      && events.some(event => event.event === 'SessionStart' && event.source === 'startup')),
    sameSessionWithinInvocation: report.runs.every(({ events }) => events.every(event => event.sessionId
      && event.sessionId === events[0].sessionId)),
    differentSessionsInSameDirectory: Boolean(ids[0] && ids[1] && ids[0] !== ids[1]),
    expectedDirectory: report.runs.every(({ events }) => events.every(event => event.cwdMatches)),
  };
  if (values.handshake) report.checks.nativeEnvironmentHandoff = report.runs.every(({events}) => {
    const result = events.find(event => event.event === 'SessionStart')?.handshake;
    return result && result.sameSession && result.generationVerified && result.entryOnly;
  });
  report.passed = Object.values(report.checks).every(Boolean);
} catch (error) {
  // Do not print native stderr, environment values, transcript paths or credentials.
  report.passed = false;
  report.failure = { phase, code: error.code ?? null, signal: error.signal ?? null, killed: error.killed === true };
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
