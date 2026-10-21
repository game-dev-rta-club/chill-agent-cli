#!/usr/bin/env node
import '../lib/quiet-sqlite-warning.mjs';
import {projectProfile,selectProjectPort,projectExtensionEnabled} from '../lib/project-workspace.mjs';
import { parseOptions, showHelp } from '../lib/cli-help.mjs';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { dataDirectory } from '../lib/goal-store.mjs';
import { serverOptions } from '../lib/server-lifecycle.mjs';
import { cloudflaredPath, publicLinkOn, tunnelStatePath } from '../lib/tunnel.mjs';
import {stopManagedTunnel} from '../lib/managed-tunnel.mjs';
import { readMessageSettings } from '../lib/message-settings.mjs';
import { stableNodePath } from '../lib/node-path.mjs';
import { prepareWithOwnInstaller } from '../lib/runtime-package.mjs';
import { prepareSelectedPackage } from '../lib/version-source.mjs';
import { launchdWebService } from '../lib/web-service-launchd.mjs';
import { windowsWebService } from '../lib/web-service-windows.mjs';

// Web startup follows the application's version file: when it selects a
// different package, start that package's own server command instead.
async function followVersionFile(directory) {
  if (process.env.CHILL_AGENT_VERSION_SWITCHED === '1') return false;
  const installed = await prepareSelectedPackage(directory, fileURLToPath(new URL('../', import.meta.url)), { prepare: prepareWithOwnInstaller, log: message => console.error(message) });
  if (!installed) return false;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(installed.root, 'bin/chill-server.mjs'), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, CHILL_AGENT_VERSION_SWITCHED: '1' } });
    child.on('error', reject);
    child.on('exit', code => { process.exitCode = code ?? 1; resolve(); });
  });
  return true;
}

async function main(attempt=0) {
  if (showHelp('server', process.argv.slice(2))) return;
  const [command = 'start', ...args] = process.argv.slice(2);
  parseOptions(`server ${command}`, args);
  if (!['darwin','win32'].includes(process.platform)) throw new Error('Background startup supports macOS launchd and Windows Task Scheduler. Use npm start -- --idle-timeout 3d on this platform.');
  if(['start','restart'].includes(command)&&!process.env.PORT&&projectProfile())await selectProjectPort();
  const { port, duration, tunnel: quick, configured } = serverOptions(args);
  const directory = dataDirectory();
  const remote = configured ? (projectExtensionEnabled('public-link')?(await readMessageSettings()).remote:{mode:'off'}) : { mode: quick ? 'quick' : 'off' };
  // A configured start resumes the panel's last On/Off choice, so a link turned Off is not awaited.
  const tunnel = remote.mode !== 'off' && (!configured || await publicLinkOn(directory));
  if (port === 0) throw new Error('Background startup requires a fixed PORT (default 4173).');
  // On macOS the connector is a launchd job that outlives Web restarts; on
  // Windows the server runs it as a child, so it closes with the server.
  const tunnels = process.platform === 'darwin';
  const stopTunnel = () => tunnels ? stopManagedTunnel(directory, port) : undefined;
  const runtime = join(directory, 'runtime', `web-${port}`);
  const log = join(runtime, 'server.log');
  const url = `http://127.0.0.1:${port}`;
  const service = (process.platform === 'win32' ? windowsWebService : launchdWebService)({ directory, port, runtime, log });
  const pid = await service.pid();
  async function publicUrl(runningPid) {
    try {
      const saved = JSON.parse(await readFile(tunnelStatePath(directory, port), 'utf8'));
      return saved.pid === Number(runningPid) ? saved.url : null;
    } catch { return null; }
  }
  if (command === 'status') {
    console.log(pid ? `Running (PID ${pid}): ${url}` : 'Stopped');
    const remote = pid && await publicUrl(pid);
    if (remote) console.log(`Tunnel: ${remote}`);
    const durationValue = await service.idleTimeout();
    if (durationValue) console.log(`Idle timeout: ${durationValue}`);
    console.log(`Log: ${log}`);
    return;
  }
  if (command === 'stop') {
    await service.stop();
    await stopTunnel();
    console.log('Stopped');
    return;
  }
  if(command==='restart' && pid)await service.prepareRestart(pid);
  if (pid && command!=='restart') throw new Error(`Server is already running at ${url}. Use npm run server:stop before changing its settings.`);
  if (attempt === 0 && await followVersionFile(directory)) return;
  // Web gets the connector found here even while the link is Off, since the panel can turn it On
  // later and a Task Scheduler Web may not share this PATH. A saved link without its connector
  // still starts local Web; the panel shows why the link failed.
  const found = await cloudflaredPath().catch(error => error);
  const connector = tunnel && typeof found === 'string' ? found : null;
  if (tunnel && !connector) { if (!configured) throw found; console.error(`Public link: ${found.message}`); }
  if(!connector)await stopTunnel();
  await service.clear();
  await mkdir(runtime, { recursive: true });
  const entry = fileURLToPath(new URL('../server.mjs', import.meta.url));
  const environment = { CHILL_AGENT_DATA_DIR: directory, PORT: String(port), ...(tunnels ? { CHILL_AGENT_MANAGED_TUNNEL:'1' } : {}), CHILL_AGENT_SERVER_STARTED_AT: String(Date.now()) };
  if (process.env.CHILL_AGENT_CODEX_PATH) environment.CHILL_AGENT_CODEX_PATH = process.env.CHILL_AGENT_CODEX_PATH;
  if (process.env.CHILL_AGENT_EXTENSIONS) environment.CHILL_AGENT_EXTENSIONS = process.env.CHILL_AGENT_EXTENSIONS;
  if (typeof found === 'string') environment.CHILL_AGENT_CLOUDFLARED_PATH = found;
  await service.start({ node: stableNodePath(), entry, args: ['--idle-timeout', duration, ...(configured ? ['--configured'] : quick ? ['--tunnel'] : [])], env: environment, cwd: dirname(entry) });
  for (let attempt = 0; attempt < (connector ? 500 : 50); attempt += 1) {
    const output = await readFile(log, 'utf8');
    const runningPid = await service.pid();
    const remote = connector && runningPid && await publicUrl(runningPid);
    if (output.includes(`chill-agent: ${url}\n`) && runningPid && (!connector || remote)) {
      await service.started();
      console.log(`Started: ${url}\n${remote ? `Tunnel: ${remote}\n` : ''}Idle timeout: ${duration}\nLog: ${log}`);
      return;
    }
    if (output.includes('Port ') && output.includes('is in use')) break;
    await delay(100);
  }
  await service.abort();
  await stopTunnel();
  if(attempt<2&&!process.env.PORT&&projectProfile()&&(await readFile(log,'utf8')).includes('is in use')){await selectProjectPort(directory,{force:true});return main(attempt+1);}
  throw new Error(`Server did not stay running. Check ${log}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
