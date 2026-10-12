import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const run = promisify(execFile);
const xml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));

// macOS: Web is a launchd job of the logged-in user.
export function launchdWebService({ directory, port, runtime, log, execute = run }) {
  const label = `com.chill-agent.web.${createHash('sha256').update(`${directory}:${port}`).digest('hex').slice(0, 12)}`;
  const domain = `gui/${process.getuid()}`, target = `${domain}/${label}`;
  const plist = join(runtime, 'server.plist');
  async function state() {
    try { return (await execute('/bin/launchctl', ['print', target])).stdout; }
    catch (error) { if (/Could not find service/.test(error.stderr || '')) return ''; throw error; }
  }
  const pidOf = output => Number(/^\s*pid = (\d+)$/m.exec(output)?.[1]) || null;
  return {
    async pid() { return pidOf(await state()); },
    async idleTimeout() {
      if (!await state()) return null;
      return /<string>--idle-timeout<\/string>\s*<string>([^<]+)<\/string>/.exec(await readFile(plist, 'utf8'))?.[1] ?? null;
    },
    // A managed connector outlives Web; let the old Web release it first.
    async prepareRestart(pid) {
      if (!(await readFile(plist, 'utf8')).includes('CHILL_AGENT_MANAGED_TUNNEL')) return;
      process.kill(pid, 'SIGUSR2');
      for (let i = 0; i < 100; i++) { if (!pidOf(await state())) break; await delay(100); }
      if (pidOf(await state())) throw Error('Web is still stopping; tunnel was preserved.');
    },
    async stop() { if (await state()) await execute('/bin/launchctl', ['bootout', target]); },
    async clear() {
      if (!await state()) return;
      await execute('/bin/launchctl', ['bootout', target]);
      for (let i = 0; i < 100 && await state(); i++) await delay(100);
      if (await state()) throw Error('Previous Web service is still stopping. Retry once it stops.');
    },
    async start({ node, entry, args, env, cwd }) {
      // This file is deliberately outside ~/Library/LaunchAgents: no login autostart.
      const config = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${[node, entry, ...args].map(v => `<string>${xml(v)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(cwd)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k,v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join('')}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
      await writeFile(plist, config, { mode: 0o600 });
      await writeFile(log, '', { mode: 0o600 });
      await execute('/bin/launchctl', ['bootstrap', domain, plist]);
    },
    async started() {},
    async abort() { await execute('/bin/launchctl', ['bootout', target]); },
  };
}
