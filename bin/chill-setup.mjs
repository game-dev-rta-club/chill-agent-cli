#!/usr/bin/env node
import {prepareProject,projectDirectory,projectProfile,workspacePort} from '../lib/project-workspace.mjs';
import { parseOptions, showHelp } from '../lib/cli-help.mjs';
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirectory } from '../lib/goal-store.mjs';
import { prepareRuntime } from '../lib/runtime-package.mjs';
import { readMessageSettings } from '../lib/message-settings.mjs';
import { resolveCodex } from '../lib/codex-client.mjs';
import { installHook } from './chill-hook.mjs';
import {configureClaudeHooks,claudeSetupStatus} from '../lib/claude-setup.mjs';
import {validateClaudeIdleDuration} from '../lib/claude-idle-duration.mjs';

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
async function main() {
  if (showHelp('setup', process.argv.slice(2))) return;
  const [command = 'status', ...args] = process.argv.slice(2);
  const values = parseOptions(`setup ${command}`, args);
  if(command==='status'&&values['--project']&&(values['--isolated']||!process.env.CHILL_AGENT_DATA_DIR)){process.env.CHILL_AGENT_DATA_DIR=await projectDirectory(values['--project']);delete process.env.PORT;}
  if(command==='prepare'&&(values['--isolated']||!process.env.CHILL_AGENT_DATA_DIR)){
    process.env.CHILL_AGENT_DATA_DIR=await prepareProject(resolve(values['--project']),{extensions:values['--extensions']===undefined?undefined:values['--extensions']==='none'?[]:values['--extensions'].split(',')});
    delete process.env.PORT;
  }else if(values['--extensions']!==undefined)throw Error('--extensions requires an isolated project setup.');
  if(command!=='status'&&Number(process.versions.node.split('.')[0])<20)throw Error('Node.js 20 or later is required.');
  if(values['--harness']==='claude-code'){
    if(!values['--project'])throw Error('Claude setup requires --project to identify its local settings.');
    if(command==='status'){console.log(JSON.stringify(await claudeSetupStatus(values['--project']),null,2));return;}
    if(process.platform==='win32')throw Error('Experimental Claude setup currently uses POSIX hooks. Windows is not qualified.');
    if(command==='remove'){console.log(JSON.stringify(await configureClaudeHooks(values['--project'],{remove:true}),null,2));return;}
    const idleWatchMs=values['--idle-watch-ms']===undefined?null:Number(values['--idle-watch-ms']);
    if(idleWatchMs!==null)validateClaudeIdleDuration(idleWatchMs);
    // Inspect before preparing a runtime; never consult Codex for this route.
    const status=await claudeSetupStatus(values['--project']);if(status.conflict)throw Error('A Claude chill hook is untracked or edited. Review it before preparing again.');
    const prepared=await prepareRuntime(fileURLToPath(new URL('../',import.meta.url)));
    // Match the launcher's canonical spelling (for example /var -> /private/var).
    const directory=await realpath(prepared.dataDirectory);
    const installed={...prepared,root:await realpath(prepared.root),dataDirectory:directory,launcher:join(directory,'runtime/chill.mjs')};
    const hook=await configureClaudeHooks(values['--project'],{launcher:installed.launcher,directory,idleWatchMs});
    const prefix=`CHILL_AGENT_DATA_DIR=${quote(installed.dataDirectory)} ${quote(process.execPath)} ${quote(installed.launcher)}`;
    console.log(JSON.stringify({...installed,project:projectProfile(),url:`http://127.0.0.1:${workspacePort()}`,hook,command:prefix,next:'Experimental Claude hooks are written, not yet verified in the conversation. Review them with native /hooks. Preserve the current chat with native resume if SessionStart has not run; never clear or fork to repair a handshake. From its main Bash tool, run <command> connection show, then connection create-goal. No Auto mode is enabled by setup. Local settings created by hand should be excluded from Git. Native policy and existing permissions still apply.'},null,2));
    return;
  }
  if(command==='remove'||values['--idle-watch-ms']!==undefined)throw Error('This option requires --harness claude-code.');
  if (command === 'status') {
    let installation = null, codex;
    try { installation = JSON.parse(await readFile(join(dataDirectory(), 'runtime', 'installation.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { codex = await resolveCodex(); } catch (error) { codex = { error: error.message }; }
    console.log(JSON.stringify({ supported: process.platform === 'darwin', node: process.version, dataDirectory: dataDirectory(),project:projectProfile(), installation, codex, settings: await readMessageSettings() }, null, 2));
    return;
  }
  if (process.platform !== 'darwin') throw new Error('The default setup supports Codex Desktop on macOS. Select --harness claude-code explicitly for the experimental POSIX route.');
  const codex = await resolveCodex();
  const installed = await prepareRuntime(fileURLToPath(new URL('../', import.meta.url)));
  const prefix = `CHILL_AGENT_DATA_DIR=${quote(installed.dataDirectory)} ${quote(process.execPath)} ${quote(installed.launcher)}`;
  const hook = await installHook(resolve(values['--project']), { command: `${prefix} hook` });
  console.log(JSON.stringify({ ...installed, project:projectProfile(),url:`http://127.0.0.1:${workspacePort()}`,codex, hook, command: prefix,
    next: 'Review/trust a new or changed hook in Codex /hooks. Start with: <command> server start --configured. Existing servers keep their previous runtime until restarted.' }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
