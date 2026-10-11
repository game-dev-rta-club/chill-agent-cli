#!/usr/bin/env node
import '../lib/quiet-sqlite-warning.mjs';
import {projectProfile,selectProjectPort,projectExtensionEnabled} from '../lib/project-workspace.mjs';
import { parseOptions, showHelp } from '../lib/cli-help.mjs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { dataDirectory } from '../lib/goal-store.mjs';
import { serverOptions } from '../lib/server-lifecycle.mjs';
import { cloudflaredPath, tunnelStatePath } from '../lib/tunnel.mjs';
import {stopManagedTunnel} from '../lib/managed-tunnel.mjs';
import { readMessageSettings } from '../lib/message-settings.mjs';
import { stableNodePath } from '../lib/node-path.mjs';

const execute = promisify(execFile);
const xml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));

async function main(attempt=0) {
  if (showHelp('server', process.argv.slice(2))) return;
  const [command = 'start', ...args] = process.argv.slice(2);
  parseOptions(`server ${command}`, args);
  if (process.platform !== 'darwin') throw new Error('Background startup uses macOS launchd. Use npm start -- --idle-timeout 3d on this platform.');
  if(['start','restart'].includes(command)&&!process.env.PORT&&projectProfile())await selectProjectPort();
  const { port, duration, tunnel: quick, configured } = serverOptions(args);
  const remote = configured ? (projectExtensionEnabled('public-link')?(await readMessageSettings()).remote:{mode:'off'}) : { mode: quick ? 'quick' : 'off' };
  const tunnel = remote.mode !== 'off';
  if (port === 0) throw new Error('Background startup requires a fixed PORT (default 4173).');
  const directory = dataDirectory();
  const label = `com.chill-agent.web.${createHash('sha256').update(`${directory}:${port}`).digest('hex').slice(0, 12)}`;
  const domain = `gui/${process.getuid()}`, target = `${domain}/${label}`;
  const runtime = join(directory, 'runtime', `web-${port}`);
  const log = join(runtime, 'server.log');
  const url = `http://127.0.0.1:${port}`;
  async function state() {
    try { return (await execute('/bin/launchctl', ['print', target])).stdout; }
    catch (error) { if (/Could not find service/.test(error.stderr || '')) return ''; throw error; }
  }
  const initial = await state();
  const pid = /^\s*pid = (\d+)$/m.exec(initial)?.[1];
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
    if (initial) {
      const config = await readFile(join(runtime, 'server.plist'), 'utf8');
      const durationValue = /<string>--idle-timeout<\/string>\s*<string>([^<]+)<\/string>/.exec(config)?.[1];
      if (durationValue) console.log(`Idle timeout: ${durationValue}`);
    }
    console.log(`Log: ${log}`);
    return;
  }
  if (command === 'stop') {
    if (initial) await execute('/bin/launchctl', ['bootout', target]);
    await stopManagedTunnel(directory,port);
    console.log('Stopped');
    return;
  }
  if(command==='restart' && pid){
    const oldConfig=await readFile(join(runtime,'server.plist'),'utf8');
    if(oldConfig.includes('CHILL_AGENT_MANAGED_TUNNEL')){
      process.kill(Number(pid),'SIGUSR2');
      for(let i=0;i<100;i++){if(!/^\s*pid = (\d+)$/m.test(await state()))break;await delay(100);}
      if(/^\s*pid = (\d+)$/m.test(await state()))throw Error('Web is still stopping; tunnel was preserved.');
    }
  }
  if (pid && command!=='restart') throw new Error(`Server is already running at ${url}. Use npm run server:stop before changing its settings.`);
  const connector = tunnel ? await cloudflaredPath() : null;
  if(!tunnel)await stopManagedTunnel(directory,port);
  if (initial) {
    await execute('/bin/launchctl', ['bootout', target]);
    for(let i=0;i<100 && await state();i++)await delay(100);
    if(await state())throw Error('Previous Web service is still stopping. Retry once it stops.');
  }
  await mkdir(runtime, { recursive: true });
  const entry = fileURLToPath(new URL('../server.mjs', import.meta.url));
  const environment = { CHILL_AGENT_DATA_DIR: directory, PORT: String(port), CHILL_AGENT_MANAGED_TUNNEL:'1', CHILL_AGENT_SERVER_STARTED_AT: String(Date.now()) };
  if (process.env.CHILL_AGENT_CODEX_PATH) environment.CHILL_AGENT_CODEX_PATH = process.env.CHILL_AGENT_CODEX_PATH;
  if (process.env.CHILL_AGENT_EXTENSIONS) environment.CHILL_AGENT_EXTENSIONS = process.env.CHILL_AGENT_EXTENSIONS;
  if (connector) environment.CHILL_AGENT_CLOUDFLARED_PATH = connector;
  // This file is deliberately outside ~/Library/LaunchAgents: no login autostart.
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${[stableNodePath(), entry, '--idle-timeout', duration, ...(configured ? ['--configured'] : quick ? ['--tunnel'] : [])].map(v => `<string>${xml(v)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(dirname(entry))}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([k,v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join('')}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
  const path = join(runtime, 'server.plist');
  await writeFile(path, plist, { mode: 0o600 });
  await writeFile(log, '', { mode: 0o600 });
  await execute('/bin/launchctl', ['bootstrap', domain, path]);
  for (let attempt = 0; attempt < (tunnel ? 500 : 50); attempt += 1) {
    const output = await readFile(log, 'utf8');
    const running = await state();
    const runningPid = /^\s*pid = (\d+)$/m.exec(running)?.[1];
    const remote = tunnel && runningPid && await publicUrl(runningPid);
    if (output.includes(`chill-agent: ${url}\n`) && runningPid && (!tunnel || remote)) {
      console.log(`Started: ${url}\n${remote ? `Tunnel: ${remote}\n` : ''}Idle timeout: ${duration}\nLog: ${log}`);
      return;
    }
    if (output.includes('Port ') && output.includes('is in use')) break;
    await delay(100);
  }
  await execute('/bin/launchctl', ['bootout', target]);
  await stopManagedTunnel(directory,port);
  if(attempt<2&&!process.env.PORT&&projectProfile()&&(await readFile(log,'utf8')).includes('is in use')){await selectProjectPort(directory,{force:true});return main(attempt+1);}
  throw new Error(`Server did not stay running. Check ${log}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
