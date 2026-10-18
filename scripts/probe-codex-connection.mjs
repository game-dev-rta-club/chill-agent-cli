// The `connection` part of scripts/probe-codex.mjs: one real round trip with a real model, in a disposable CODEX_HOME,
// project and chill data directory. Feedback goes through chill's CLI into a chat held by a long-lived app-server
// (standing in for Desktop); the model must answer through chill's CLI.
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {installHook} from '../bin/chill-hook.mjs';
import {readTurnSettings} from '../lib/agents/codex-turn-settings.mjs';
import {contractMethods, requestViolations, responseViolations} from '../test/codex-contract.mjs';
import {AppServer, fakeModel, hookTap, makeDir, makeHome, removeMade, shellCall, sleep, textItem, uuid} from './probe-codex-kit.mjs';

// The latest Sol confirmed to work with chill; update when a newer one is confirmed. Override with --model and --effort.
export const SOL = {model: 'gpt-6.1-sol', effort: 'medium'};

const cli = fileURLToPath(new URL('../bin/chill-agent.mjs', import.meta.url));
const run = (file, args, options = {}) => new Promise(resolve => {
  const child = execFile(file, args, {...options, timeout: options.timeout ?? 60000, maxBuffer: 4 << 20}, (error, stdout, stderr) => resolve({code: error ? (error.code ?? 1) : 0, stdout, stderr}));
  child.stdin.end(options.input ?? '');
});
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');

// Reads only the expiry of the access token, never printing or copying it.
function authPreflight(path) {
  if (!existsSync(path)) throw new Error(`No Codex login at ${path}. Run codex login first.`);
  const tokens = JSON.parse(readFileSync(path, 'utf8')).tokens ?? {};
  const exp = JSON.parse(Buffer.from(String(tokens.access_token).split('.')[1], 'base64url').toString()).exp * 1000;
  if (exp < Date.now() + 3600e3) throw new Error('The Codex access token expires within an hour. Open Codex Desktop once so it refreshes, then rerun (a refresh inside the probe could rotate your login).');
}

export async function runConnection({codex, log, options}) {
  const rehearsal = Boolean(options['fake-model']);
  const model = options.model ?? SOL.model, effort = options.effort ?? SOL.effort, timeout = Number(options.timeout ?? 300) * 1000;
  const checks = [];
  const check = (name, ok, detail = '') => { checks.push({name, ok: Boolean(ok), ...(detail && !ok ? {detail: String(detail)} : {})}); log(`${ok ? 'pass' : 'FAIL'}  ${name}${ok || !detail ? '' : `  (${String(detail).slice(0, 400)})`}`); };

  const userAuth = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
  if (!rehearsal) authPreflight(userAuth);
  const nonce = Math.random().toString(36).slice(2, 8);
  const fake = rehearsal ? await fakeModel(scriptedAgent(nonce)) : null;
  const home = makeHome('chill-codex-conn-', '');
  const project = makeDir('chill-codex-conn-project-'), data = join(project, '.chill-data');
  mkdirSync(data);
  writeFileSync(join(home, 'config.toml'), [
    fake ? fake.top : `model = "${model}"\nmodel_reasoning_effort = "${effort}"\n`,
    `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(home)}]\n`,
    `[shell_environment_policy]\ninherit = "all"\n[shell_environment_policy.set]\nCHILL_AGENT_CODEX_PATH = ${JSON.stringify(codex.path)}\nCODEX_HOME = ${JSON.stringify(home)}\nCHILL_AGENT_DATA_DIR = ${JSON.stringify(data)}\n`,
    fake?.tables ?? '',
  ].join('\n'));
  const authLink = join(home, 'auth.json');
  const authBefore = rehearsal ? null : sha(userAuth);
  if (!rehearsal) symlinkSync(userAuth, authLink);

  const cliEnv = {PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: home, CODEX_HOME: home, CHILL_AGENT_CODEX_PATH: codex.path, CHILL_AGENT_DATA_DIR: data};
  const chill = (args, input) => run(process.execPath, [cli, ...args], {env: cliEnv, cwd: project, input});
  const saved = {CHILL_AGENT_DATA_DIR: process.env.CHILL_AGENT_DATA_DIR, CHILL_AGENT_CODEX_PATH: process.env.CHILL_AGENT_CODEX_PATH, CODEX_HOME: process.env.CODEX_HOME, HOME: process.env.HOME};
  Object.assign(process.env, {CHILL_AGENT_DATA_DIR: data, CHILL_AGENT_CODEX_PATH: codex.path, CODEX_HOME: home});
  const A = new AppServer(codex.path, home, 'A', fake ? {FAKE_KEY: 'x'} : {});
  const result = {model: fake ? 'scripted fake model (rehearsal, nothing recorded)' : model, effort: fake ? 'medium' : effort, usage: {}, rehearsal};
  try {
    log(`codex ${codex.version}; model ${result.model}${fake ? '' : `, effort ${effort}`}; disposable CODEX_HOME ${home}`);
    const violations = [], validated = new Set();
    const validate = (method, params, reply) => {
      if (!contractMethods.includes(method)) return;
      validated.add(method);
      violations.push(...[...requestViolations(method, params), ...(reply.result ? responseViolations(method, reply.result) : [])].map(text => `${method}: ${text}`));
    };
    const direct = async (method, params) => { const res = await A.call(method, params, 30000); const reply = res.error ? {error: res.error} : res.timeout ? {error: {message: 'timeout'}} : {result: res.result}; validate(method, params, reply); return reply; };
    await A.init();
    const turnsDone = () => A.notes.filter(note => note.method === 'turn/completed').length;
    const waitTurns = async (count, ms) => { const end = Date.now() + ms; while (turnsDone() < count && Date.now() < end) await sleep(100); return turnsDone() >= count; };

    const models = await direct('model/list', {});
    const offered = models.result?.data?.find(entry => entry.model === model);
    if (!fake) check(`Codex offers ${model} with reasoning effort ${effort}`, offered && offered.supportedReasoningEfforts.some(entry => entry.reasoningEffort === effort), models.error?.message ?? `models: ${models.result?.data?.map(entry => entry.model).join()}`);
    if (!fake) { const limits = await direct('account/rateLimits/read', {}); check('account/rateLimits/read answers for the signed-in account', Boolean(limits.result), limits.error?.message); }

    const created = await chill(['create', '--title', 'Connection probe', '--scope', 'Check the Codex connection', '--criteria', 'One reply is recorded']);
    const goalId = JSON.parse(created.stdout || '{}').id;
    check('chill creates a Goal', created.code === 0 && goalId, created.stderr);

    const file = await installHook(project);
    const wanted = JSON.parse(readFileSync(file, 'utf8')).hooks.PostToolUse[0].hooks[0];
    const tap = hookTap(project, wanted.command);
    writeFileSync(file, JSON.stringify({hooks: {PostToolUse: [{matcher: '*', hooks: [{...wanted, command: tap.command}]}]}}, null, 2));
    await direct('config/value/write', {keyPath: `projects."${project}".trust_level`, value: 'trusted', mergeStrategy: 'upsert'});
    const hook = (await direct('hooks/list', {cwds: [project]})).result?.data?.[0]?.hooks?.[0];
    const trusted = await direct('config/value/write', {keyPath: `hooks.state."${hook?.key}".trusted_hash`, value: hook?.currentHash, mergeStrategy: 'upsert'});
    check('the project hook is installed and trusted for the probe', hook && trusted.result?.status === 'ok', JSON.stringify(trusted.error));
    // Codex reads a chat's hooks when the chat starts, so the hook is trusted before the chat exists.
    const thread = (await direct('thread/start', {cwd: project, approvalPolicy: 'never', sandbox: 'workspace-write'})).result?.thread;
    const first = await direct('thread/queue/add', {threadId: thread.id, input: [{type: 'text', text: 'Reply with the single word ready. Do not run any tool.', text_elements: []}], clientUserMessageId: uuid(1)});
    check('the chat answers its first message', first.result && await waitTurns(1, 120000), first.error?.message);
    const chatId = thread.id;
    const assigned = await chill(['assign', '--id', goalId, '--thread-id', chatId]);
    check('goal assign accepts the chat (thread/read and thread/queue/list from chill\'s own app-server)', assigned.code === 0, assigned.stderr || assigned.stdout);

    const text = `Connection probe ${nonce}. Run the shell command pwd as your very first command. Then reply on this Goal with exactly one comment saying "probe reply ${nonce}", using the chill-agent reply command given with this feedback. Do not read, create or edit any file and run no other command.`;
    const mark = A.notes.length, usageBefore = lastUsage(A, chatId);
    const sent = await chill(['feedback', '--id', goalId, '--input-file', '-'], JSON.stringify({text, requestId: `probe-${nonce}`}));
    const deliveries = sent.stdout.trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return {}; } });
    const delivery = deliveries.at(-1)?.delivery;
    check('goal feedback saves the message and sends it to the idle chat as its next message', sent.code === 0 && delivery?.status === 'queued', sent.stderr || JSON.stringify(delivery));

    const started = await A.waitNote(note => note.method === 'turn/started' && note.params.threadId === chatId, 60000, mark);
    check('the queued feedback starts a turn in the chat', Boolean(started));
    const finished = await waitTurns(2, timeout);
    if (!finished) { await direct('turn/interrupt', {threadId: chatId, turnId: started?.params.turn.id}); }
    check(`the turn completes within ${timeout / 1000} s`, finished, 'timed out; the turn was interrupted');

    const turns = (await direct('thread/turns/list', {threadId: chatId, itemsView: 'full', limit: 5})).result?.data ?? [];
    const eventId = deliveries[0]?.feedback?.changeId ?? 1;
    const turn = turns.find(entry => entry.items.some(item => item.type === 'userMessage' && JSON.stringify(item.content).includes(`probe reply ${nonce}`)));
    check('the turn\'s userMessage carries the feedback as data, with its event ID', turn && JSON.stringify(turn.items[0].content).includes(`\\"eventId\\":${eventId},`), JSON.stringify(turn?.items[0]).slice(0, 200));
    const commands = (turn?.items ?? []).filter(item => item.type === 'commandExecution').map(item => item.command);
    const traces = tap.read();
    check('the PostToolUse hook ran in that turn and handed nothing twice', traces.length > 0 && traces.every(entry => entry.code === 0 && entry.output === ''), `${traces.length} runs, commands: ${commands.join(' | ').slice(0, 300)}`);
    check('the model replied on the Goal through chill', commands.some(command => new RegExp(`comment --id ${goalId}\\b`).test(command)), commands.join(' | ').slice(0, 400));
    const shown = JSON.parse((await chill(['show', '--id', goalId, '--format', 'json'])).stdout || '{}');
    const reply = shown.conversation?.find(entry => entry.author === 'agent' && String(entry.text).includes(`probe reply ${nonce}`));
    check('the model\'s comment is in the Goal\'s Conversation', Boolean(reply), JSON.stringify(shown.conversation?.map(entry => entry.text)).slice(0, 300));
    const queue = await direct('thread/queue/list', {threadId: chatId});
    check('Codex\'s queue is empty afterwards', queue.result?.data?.length === 0, JSON.stringify(queue));
    const view = (await (await import('../lib/agents/index.mjs')).deliveriesWithWork(String(goalId))).find(entry => entry.eventId === eventId);
    check('the reply answers the Goal, and chill reads the turn\'s output back as its Think', view?.status === 'completed' && view.work?.source === 'turn' && view.work.status === 'completed' && view.work.turnId === turn?.id && view.work.messages.length > 0, JSON.stringify(view).slice(0, 300));
    const settings = await readTurnSettings((await direct('thread/read', {threadId: chatId, includeTurns: false})).result.thread.path, turn?.id);
    check('the turn ran on the configured model and effort', fake ? settings?.model === 'fake-model' : settings?.model === model && settings.reasoning === effort, JSON.stringify(settings));

    check(`schema: the round trip's ${[...validated].join(', ')} requests and responses match test/fixtures/codex-app-server-schema.json`, violations.length === 0, violations.slice(0, 3).join('; '));
    const usage = lastUsage(A, chatId);
    result.usage = {thisFeedbackTurn: diff(usage, usageBefore), chat: usage};
    const plain = command => command.replace(/^\S*zsh -lc /, '').replace(/PORT='\d+' CHILL_AGENT_DATA_DIR='[^']*' '[^']*' '[^']*chill-agent\.mjs'/g, 'chill').replaceAll('"', '').slice(0, 200);
    result.turn = {tools: commands.map(plain), hookRuns: traces.length, messages: (turn?.items ?? []).filter(item => item.type === 'agentMessage' && item.text).map(item => item.text.slice(0, 200))};
    log(`usage  this feedback turn ${JSON.stringify(result.usage.thisFeedbackTurn)}; the chat so far ${JSON.stringify(usage)}`);
  } finally {
    await A.stop(); await fake?.close();
    try { unlinkSync(authLink); } catch { /* no link in a rehearsal */ }
    const linkGone = !existsSync(authLink);
    removeMade();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (!rehearsal) check('the Codex login file is unchanged and the probe\'s link to it is removed', sha(userAuth) === authBefore && linkGone);
  }
  return {...result, checks};
}

const lastUsage = (server, threadId) => server.notes.filter(note => note.method === 'thread/tokenUsage/updated' && note.params.threadId === threadId).at(-1)?.params.tokenUsage.total ?? null;
const diff = (now, before) => now && Object.fromEntries(Object.entries(now).filter(([, value]) => typeof value === 'number').map(([key, value]) => [key, value - (before?.[key] ?? 0)]));

// A stand-in for the real model that follows the same path: a first command, then a reply on the Goal.
function scriptedAgent(nonce) {
  return request => {
    const at = request.input.findLastIndex(item => item.role === 'user' && JSON.stringify(item.content).includes('chill-agent · User Feedback'));
    if (at < 0) return [textItem('ready')];
    const calls = request.input.slice(at + 1).filter(item => item.type === 'function_call').length;
    const feedback = request.input[at].content.map(part => part.text).join('\n');
    const prefix = feedback.match(/this answers it\): (PORT=.*) comment --id <goalId>/)?.[1], goal = feedback.match(/"goalId":"(\d+)"/)?.[1];
    const steps = ['pwd', `${prefix} comment --id ${goal} --text 'probe reply ${nonce}'`];
    return calls < steps.length ? [shellCall(steps[calls])] : [textItem('done')];
  };
}
