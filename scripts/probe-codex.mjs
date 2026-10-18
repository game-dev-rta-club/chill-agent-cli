#!/usr/bin/env node
// Checks chill-agent against the installed Codex Desktop app-server. Opt-in, macOS only, never part of `npm run check`.
//   node scripts/probe-codex.mjs                    protocol: every Codex behavior chill relies on, fake model, no cost
//   node scripts/probe-codex.mjs connection --run   one real round trip with a real model (needs `codex login`)
// Everything runs in a disposable CODEX_HOME and data directory. See docs/development/codex-verification.md.
import {execFile} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {parseArgs, promisify} from 'node:util';
import {resolveCodex} from '../lib/codex-client.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const usage = `Usage: node scripts/probe-codex.mjs [protocol|connection] [--run] [--model <id>] [--effort <level>] [--timeout <seconds>]
protocol (default)  Every Codex behavior chill relies on, checked against the installed app-server with a fake model. No account, no cost, about a minute.
connection --run    One real round trip: feedback reaches a chat, the hook guides the model, the model answers in chill. Uses a real model and your Codex login (read-only link, removed afterwards).
Both write docs/development/codex-verification/<codex version>.json and exit 1 when a check fails.`;

const {values, positionals} = parseArgs({allowPositionals: true, options: {run: {type: 'boolean'}, 'fake-model': {type: 'boolean'}, model: {type: 'string'}, effort: {type: 'string'}, timeout: {type: 'string'}, help: {type: 'boolean'}}});
const part = positionals[0] ?? 'protocol';
if (values.help || !['protocol', 'connection'].includes(part) || positionals.length > 1) { console.log(usage); process.exit(values.help ? 0 : 2); }
if (process.platform !== 'darwin') { console.error('The Codex Desktop probe runs on macOS only.'); process.exit(2); }
if (part === 'connection' && !values.run) { console.log(`${usage}\n\nThe connection part calls a real model. Pass --run to start it.`); process.exit(0); }

const codex = await resolveCodex();
const log = line => console.log(line);
const git = async (...args) => (await exec('git', args, {cwd: root})).stdout.trim();
const recordPath = new URL(`../docs/development/codex-verification/${codex.version.replace(/^codex-cli /, '')}.json`, import.meta.url);

const result = part === 'protocol'
  ? await (await import('./probe-codex-protocol.mjs')).runProtocol({codex, log})
  : await (await import('./probe-codex-connection.mjs')).runConnection({codex, log, options: values});

const passed = result.checks.filter(check => check.ok).length, failed = result.checks.length - passed;
log(`\n${part}: ${passed} passed, ${failed} failed (codex ${codex.version})`);
if (result.rehearsal) { log('Rehearsal with a scripted model: nothing recorded.'); process.exit(failed ? 1 : 0); }

let record = {};
try { record = JSON.parse(await readFile(recordPath, 'utf8')); } catch { /* first record for this version */ }
const dirty = (await git('status', '--porcelain', '--untracked-files=no', '--', '.', ':!docs/development/codex-verification')).length > 0;
record = {...record, codex: codex.version, [part]: {passed: failed === 0, date: new Date().toISOString(), chill: {commit: await git('rev-parse', '--short', 'HEAD'), uncommittedChanges: dirty}, ...result}};
await mkdir(new URL('.', recordPath), {recursive: true});
await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
log(`Recorded in ${recordPath.pathname.slice(root.length)}`);
process.exitCode = failed ? 1 : 0;
