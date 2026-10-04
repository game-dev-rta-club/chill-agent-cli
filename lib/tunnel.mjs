import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeJsonAtomically } from './goal-store.mjs';
import { namedTunnelConfig } from './message-settings.mjs';

export const tunnelStatePath = (directory, port) => join(directory, 'runtime', `web-${port}`, 'tunnel.json');

export async function cloudflaredPath(env = process.env) {
  const paths = env.CHILL_AGENT_CLOUDFLARED_PATH
    ? [env.CHILL_AGENT_CLOUDFLARED_PATH]
    : [...(env.PATH || '').split(':').filter(Boolean).map(path => join(path, 'cloudflared')), '/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'];
  for (const path of paths) {
    try { await access(path, constants.X_OK); return path; } catch { /* Try the next installation. */ }
  }
  throw new Error('cloudflared was not found. Install it before starting with --tunnel.');
}

// The server owns the connector. A temporary URL is never reused after restart.
export async function startTunnel({ directory, port, onOrigin, onFailure, remote = { mode: 'quick' } }) {
  const path = tunnelStatePath(directory, port);
  await mkdir(dirname(path), { recursive: true });
  await rm(path, { force: true });
  const binary = await cloudflaredPath();
  let args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`];
  if (remote.mode === 'named') {
    const configPath = join(dirname(path), 'cloudflared.json');
    const config = namedTunnelConfig(remote, port);
    await access(remote.credentialsFile, constants.R_OK);
    await writeJsonAtomically(configPath, config);
    args = ['tunnel', '--no-autoupdate', '--config', configPath, 'run', remote.tunnelId];
  } else if (remote.mode !== 'quick') throw new Error('Tunnel mode must be quick or named.');
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stopped = false, announced = false, tail = '', save = Promise.resolve();
  const timer = setTimeout(() => fail('Cloudflare did not establish a tunnel within 45 seconds.'), 45000);
  const exited = new Promise(resolve => child.once('close', resolve));
  function fail(message) {
    if (stopped) return;
    onFailure(new Error(message));
  }
  function output(chunk) {
    if (stopped) return;
    tail = (tail + chunk.toString()).slice(-8000);
    const url = remote.mode === 'named'
      ? (/Registered tunnel connection/.test(tail) ? remote.url : null)
      : /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com(?=[\s|"']|$)/.exec(tail)?.[0];
    if (!url || announced) return;
    announced = true;
    clearTimeout(timer);
    save = writeJsonAtomically(path, { url, pid: process.pid, createdAt: new Date().toISOString() });
    void save.then(() => {
      if (!stopped) { onOrigin(url); console.log(`Tunnel: ${url}`); }
    }).catch(error => fail(`Could not save tunnel URL: ${error.message}`));
  }
  child.stdout.on('data', output);
  child.stderr.on('data', output);
  child.on('error', error => fail(`Could not start cloudflared: ${error.message}`));
  child.on('close', code => {
    clearTimeout(timer);
    onOrigin(null);
    fail(`Cloudflare tunnel stopped (${code ?? 'signal'}).`);
  });
  return async () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    onOrigin(null);
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 1500);
    await exited;
    clearTimeout(force);
    await save.catch(() => {});
    await rm(path, { force: true });
  };
}
