import { spawn, execFile } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';

const exec = promisify(execFile);
const timeout = 10000;

// Follow the Desktop bundle, not a potentially older `codex` on PATH.
export async function resolveCodex() {
  const explicit = process.env.CHILL_AGENT_CODEX_PATH;
  if (explicit && !isAbsolute(explicit)) throw new Error('CHILL_AGENT_CODEX_PATH must be absolute.');
  const candidates = explicit ? [explicit] : [];
  if (!explicit && process.platform === 'darwin') {
    const bundles = [];
    try {
      const { stdout } = await exec('/usr/bin/osascript', ['-e', 'POSIX path of (path to application id "com.openai.codex")'], { timeout: 3000, maxBuffer: 4096 });
      bundles.push(stdout.trim());
    } catch { /* Standard install locations are also checked. */ }
    for (const directory of ['/Applications', join(homedir(), 'Applications')]) {
      bundles.push(join(directory, 'ChatGPT.app'), join(directory, 'Codex.app'));
    }
    for (const bundle of new Set(bundles)) {
      candidates.push(join(bundle, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'), join(bundle, 'Contents/Resources/codex'));
    }
  }
  for (const candidate of candidates) {
    try {
      const path = await realpath(candidate);
      await access(path, constants.X_OK);
      const { stdout } = await exec(path, ['--version'], { timeout, maxBuffer: 4096 });
      if (!/codex-cli \S+/.test(stdout)) continue;
      return { path, version: stdout.trim() };
    } catch { /* Try the next bundle layout. */ }
  }
  throw new Error('Desktop Codex not found. Set CHILL_AGENT_CODEX_PATH to its executable.');
}

export class CodexClient {
  constructor(runtime) {
    this.runtime = runtime;
    this.pending = new Map();
    this.nextId = 0;
    this.child = spawn(runtime.path, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', () => this.fail(new Error('Codex connection closed.')));
    this.child.stdin.on('error', error => this.fail(error));
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === undefined) return;
      if (message.method) {
        // This transport only enqueues input. It never executes model tools.
        this.write({ id: message.id, error: { code: -32601, message: 'No client tools available.' } });
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message), { rpcError: true }));
      else pending.resolve(message.result);
    });
  }
  write(message) { this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  fail(error) {
    this.error = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  request(method, params) {
    if (this.error) return Promise.reject(this.error);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex timed out: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'chill_agent', title: 'chill-agent', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.write({ method: 'initialized', params: {} });
  }
  close() {
    this.fail(new Error('Codex connection closed.'));
    this.lines.close();
    this.child.stdin.end();
    this.child.kill('SIGTERM');
    const kill = setTimeout(() => this.child.kill('SIGKILL'), 1000);
    kill.unref();
    this.child.once('exit', () => clearTimeout(kill));
  }
}

export async function withCodex(run) {
  const client = new CodexClient(await resolveCodex());
  const stop = () => { client.close(); process.exit(143); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try { await client.initialize(); return await run(client); }
  finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); client.close(); }
}

export async function verifyThread(threadId) {
  return withCodex(async client => {
    const { thread } = await client.request('thread/read', { threadId, includeTurns: false });
    if (thread?.id !== threadId || thread.ephemeral) throw new Error('A saved Desktop chat is required.');
    // Also check that this runtime supports the queue API before preparing the connection.
    await client.request('thread/queue/list', { threadId, limit: 1 });
    return thread;
  });
}
