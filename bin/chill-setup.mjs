#!/usr/bin/env node
import { parseOptions, showHelp } from '../lib/cli-help.mjs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirectory } from '../lib/goal-store.mjs';
import { prepareRuntime } from '../lib/runtime-package.mjs';
import { readMessageSettings } from '../lib/message-settings.mjs';
import { resolveCodex } from '../lib/codex-client.mjs';
import { installHook } from './chill-hook.mjs';

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
async function main() {
  if (showHelp('setup', process.argv.slice(2))) return;
  const [command = 'status', ...args] = process.argv.slice(2);
  const values = parseOptions(`setup ${command}`, args);
  if (command === 'status') {
    let installation = null, codex;
    try { installation = JSON.parse(await readFile(join(dataDirectory(), 'runtime', 'installation.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { codex = await resolveCodex(); } catch (error) { codex = { error: error.message }; }
    console.log(JSON.stringify({ supported: process.platform === 'darwin', node: process.version, dataDirectory: dataDirectory(), installation, codex, settings: await readMessageSettings() }, null, 2));
    return;
  }
  if (process.platform !== 'darwin') throw new Error('The current integration supports Codex Desktop on macOS. Claude and other platforms are not connected yet.');
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20 or later is required.');
  const codex = await resolveCodex();
  const installed = await prepareRuntime(fileURLToPath(new URL('../', import.meta.url)));
  const prefix = `CHILL_AGENT_DATA_DIR=${quote(installed.dataDirectory)} ${quote(process.execPath)} ${quote(installed.launcher)}`;
  const hook = await installHook(resolve(values['--project']), { command: `${prefix} hook` });
  console.log(JSON.stringify({ ...installed, codex, hook, command: prefix,
    next: 'Review/trust a new or changed hook in Codex /hooks. Start with: <command> server start --configured. Existing servers keep their previous runtime until restarted.' }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
