// Shared pieces of scripts/probe-codex.mjs: a JSON-RPC client for the installed Codex app-server,
// a disposable CODEX_HOME, and a fake Responses-API model that answers at zero cost.
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';

export const sleep = delay;
export const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export class AppServer {
  constructor(codexPath, home, name, env = {}) {
    this.name = name; this.pending = new Map(); this.notes = []; this.serverRequests = []; this.nextId = 0; this.stderr = '';
    this.child = spawn(codexPath, ['app-server', '--listen', 'stdio://'], {env: {...process.env, CODEX_HOME: home, HOME: home, ...env}, stdio: ['pipe', 'pipe', 'pipe']});
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-4000); });
    this.exited = new Promise(resolve => this.child.on('exit', resolve));
    createInterface({input: this.child.stdout}).on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined && message.method) {
        this.serverRequests.push(message.method);
        this.write({id: message.id, error: {code: -32601, message: 'probe has no client tools'}});
      } else if (message.id !== undefined) {
        const entry = this.pending.get(message.id); if (!entry) return;
        this.pending.delete(message.id); clearTimeout(entry.timer); entry.resolve(message);
      } else this.notes.push(message);
    });
  }
  write(message) { this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  call(method, params, timeout = 15000) {
    const id = ++this.nextId;
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({id, timeout: true}); }, timeout);
      this.pending.set(id, {resolve, timer});
      this.write({id, method, params});
    });
  }
  async init() {
    this.initParams = {clientInfo: {name: `probe_${this.name}`, title: 'chill-agent probe', version: '0'}, capabilities: {experimentalApi: true}};
    const reply = await this.call('initialize', this.initParams);
    this.write({method: 'initialized', params: {}});
    return reply;
  }
  async waitNote(match, timeout = 30000, from = 0) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const found = this.notes.slice(from).find(match);
      if (found) return found;
      await delay(50);
    }
    return null;
  }
  async stop() { this.child.kill('SIGTERM'); await Promise.race([this.exited, delay(2000)]); this.child.kill('SIGKILL'); }
}

export const textItem = text => ({type: 'message', role: 'assistant', id: `msg_${Math.random().toString(36).slice(2)}`, status: 'completed', content: [{type: 'output_text', text, annotations: []}]});
export const shellCall = (cmd, id = `call_${Math.random().toString(36).slice(2)}`) => ({type: 'function_call', id: `fc_${id}`, call_id: id, name: 'exec_command', arguments: JSON.stringify({cmd}), status: 'completed'});

// `script(request, index)` returns (or resolves to) the output items of one model response.
export async function fakeModel(script = (_request, index) => [textItem(`reply ${index}`)]) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      if (!req.url.includes('responses')) { res.writeHead(404); res.end(); return; }
      let parsed = {}; try { parsed = JSON.parse(body); } catch {}
      requests.push(parsed);
      const index = requests.length, id = `resp_${index}`, items = await script(parsed, index);
      res.writeHead(200, {'content-type': 'text/event-stream'});
      const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({type, ...data})}\n\n`);
      event('response.created', {response: {id}});
      items.forEach((item, output_index) => event('response.output_item.done', {output_index, item}));
      event('response.completed', {response: {id, output: items, usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: {cached_tokens: 0}, output_tokens_details: {reasoning_tokens: 0}}}});
      res.end();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const top = 'model = "fake-model"\nmodel_reasoning_effort = "medium"\nmodel_provider = "fake"\n';
  const tables = `[model_providers.fake]\nname = "fake"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nenv_key = "FAKE_KEY"\n`;
  return {requests, port, close: () => new Promise(resolve => server.close(resolve)), top, tables, config: top + tables};
}

const made = [];
export const makeDir = prefix => { const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix))); made.push(dir); return dir; };
// Removes every directory makeDir created. rmSync unlinks a symlink such as auth.json without following it.
export const removeMade = () => { for (const dir of made.splice(0)) rmSync(dir, {recursive: true, force: true}); };
export const makeHome = (prefix, config) => {
  const home = makeDir(prefix);
  writeFileSync(join(home, 'config.toml'), config);
  return home;
};

// A hook command that records the stdin Codex gave it, then runs the real command unchanged.
export function hookTap(directory, command) {
  const trace = join(directory, 'hook-trace.jsonl'), script = join(directory, 'hook-tap.mjs');
  writeFileSync(script, `import {spawn} from 'node:child_process';import {appendFileSync} from 'node:fs';
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks).toString('utf8');
const child = spawn('/bin/sh', ['-c', ${JSON.stringify(command)}], {stdio: ['pipe', 'pipe', 'inherit']});
let output = ''; child.stdout.on('data', chunk => { output += chunk; });
child.stdin.end(input);
const code = await new Promise(resolve => child.on('exit', resolve));
appendFileSync(${JSON.stringify(trace)}, JSON.stringify({input: JSON.parse(input), output, code}) + '\\n');
process.stdout.write(output); process.exitCode = code ?? 1;
`);
  const read = () => { try { return readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  return {command: `${quote(process.execPath)} ${quote(script)}`, read};
}
export const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

// Compact structural signature of a JSON value: key names and value types, never values.
export function shapeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length ? [shapeOf(value[0])] : [];
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shapeOf(child)]));
  return typeof value;
}
// Where two shapes disagree, as `path: real X, fake Y` lines. An empty array matches any array.
export function shapeDiff(real, fake, path = '$') {
  const kind = shape => shape === null ? 'null' : Array.isArray(shape) ? 'array' : typeof shape === 'object' ? 'object' : shape;
  if (kind(real) !== kind(fake)) return [`${path}: real ${kind(real)}, fake ${kind(fake)}`];
  if (kind(real) === 'array') return real.length && fake.length ? shapeDiff(real[0], fake[0], `${path}[]`) : [];
  if (kind(real) !== 'object') return [];
  const lines = [];
  for (const key of new Set([...Object.keys(real), ...Object.keys(fake)])) {
    if (!(key in fake)) lines.push(`${path}.${key}: only in real`);
    else if (!(key in real)) lines.push(`${path}.${key}: only in fake`);
    else lines.push(...shapeDiff(real[key], fake[key], `${path}.${key}`));
  }
  return lines;
}
