import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { readJson, writeJsonAtomically } from './storage.mjs';

const run = promisify(execFile);
const xml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

// Quote one argument the way Windows programs split their command line.
export function commandLineArgument(value) {
  const text = String(value);
  if (text && !/[\s"]/.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

export const taskName = directory => `\\chill-agent\\web-${createHash('sha256').update(directory).digest('hex').slice(0, 12)}`;

// No trigger: the task never starts at logon, only when `server start` runs it.
// It runs as the current user while logged on, without elevation or a password.
export function taskXml({ command, args, cwd, description = 'chill-agent Web' }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${xml(description)}</Description></RegistrationInfo>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xml(command)}</Command><Arguments>${xml(args.map(commandLineArgument).join(' '))}</Arguments><WorkingDirectory>${xml(cwd)}</WorkingDirectory></Exec></Actions>
</Task>
`;
}

// Register and run a Node program as its own task. Node is a console program:
// started directly, it opens a terminal window that stops it when closed. A
// headless console host shows none.
export async function runHeadlessTask({ name, file, args, cwd, description, execute = run }) {
  const consoleHost = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'conhost.exe');
  await writeFile(file, '\ufeff' + taskXml({ command: consoleHost, args: ['--headless', ...args], cwd, description }), 'utf16le');
  await execute('schtasks', ['/Create', '/TN', name, '/XML', file, '/F'], { windowsHide: true });
  await execute('schtasks', ['/Run', '/TN', name], { windowsHide: true });
}
// A process's command line, or '' when it has ended. Callers use it to never end
// a process whose ID was reused by another program.
export async function commandLineOf(pid, execute = run) {
  try {
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8;(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').CommandLine`], { windowsHide: true, encoding: 'utf8' });
    return stdout;
  } catch { return ''; }
}
export const deleteTask = (name, execute = run) => execute('schtasks', ['/Delete', '/TN', name, '/F'], { windowsHide: true }).catch(() => {});

// Windows: Task Scheduler starts Web outside the calling app, so a packaged app
// such as Claude Desktop does not take Web down when it closes. The task is only
// a launcher: its registration is removed once Web is running.
export function windowsWebService({ directory, runtime, log, execute = run }) {
  const name = taskName(directory), file = join(runtime, 'service.json'), statePath = join(runtime, 'service-state.json');
  const launcher = fileURLToPath(new URL('../bin/chill-web-task.mjs', import.meta.url));
  async function current() {
    const [state, service] = await Promise.all([readJson(statePath), readJson(file)]);
    return state && service && Number.isInteger(state.pid) && alive(state.pid) ? { ...state, service } : null;
  }
  // Never end a process whose ID was reused by another program.
  async function ours(pid, service) {
    const line = await commandLineOf(pid, execute);
    return line.includes(file) || line.includes(service.entry);
  }
  const unregister = () => deleteTask(name, execute);
  async function stop() {
    const running = await current();
    if (running) {
      try {
        await fetch(`http://127.0.0.1:${running.service.env.PORT}/api/service/shutdown`, { method: 'POST', headers: { 'x-chill-service': running.service.token }, signal: AbortSignal.timeout(3000) });
      } catch { /* Ended below. */ }
      for (let i = 0; i < 100 && alive(running.pid); i++) await delay(100);
      for (const pid of [running.task, running.pid]) {
        if (alive(running.pid) && Number.isInteger(pid) && alive(pid) && await ours(pid, running.service)) await execute('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
      }
      for (let i = 0; i < 50 && alive(running.pid); i++) await delay(100);
      if (alive(running.pid)) throw Error(`Web is still running (PID ${running.pid}). Retry once it stops.`);
    }
    await unregister();
  }
  return {
    async pid() { return (await current())?.pid ?? null; },
    async idleTimeout() {
      const args = (await current())?.service.args ?? [];
      return args.includes('--idle-timeout') ? args[args.indexOf('--idle-timeout') + 1] : null;
    },
    // A restart asks Web to release, not stop, its public link connector, as
    // SIGUSR2 does on macOS, so the new Web reattaches and the URL stays.
    async prepareRestart() {
      const running = await current();
      if (!running?.service.env?.CHILL_AGENT_MANAGED_TUNNEL) return;
      try {
        await fetch(`http://127.0.0.1:${running.service.env.PORT}/api/service/shutdown`, { method: 'POST', headers: { 'x-chill-service': running.service.token, 'x-chill-preserve-tunnel': '1' }, signal: AbortSignal.timeout(3000) });
      } catch { return; }
      for (let i = 0; i < 100 && alive(running.pid); i++) await delay(100);
      if (alive(running.pid)) throw Error('Web is still stopping; tunnel was preserved.');
    },
    stop,
    clear: stop,
    async start({ node, entry, args, env, cwd }) {
      const token = randomBytes(32).toString('hex');
      await rm(statePath, { force: true });
      await writeJsonAtomically(file, { entry, args, cwd, log, state: statePath, token, env: { ...env, CHILL_AGENT_SERVICE_TOKEN: token } });
      await writeFile(log, '');
      await runHeadlessTask({ name, file: join(runtime, 'task.xml'), args: [node, launcher, file], cwd, execute });
    },
    started: unregister,
    abort: stop,
  };
}
