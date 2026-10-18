// The `protocol` part of scripts/probe-codex.mjs: every Codex behavior chill-agent relies on, checked against the
// installed app-server with a fake model (no account, no cost), plus the same request sequence replayed on test/fake-codex.mjs.
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {deepStrictEqual} from 'node:assert/strict';
import {withCodex, verifyThread} from '../lib/codex-client.mjs';
import {readTurnSettings} from '../lib/agents/codex-turn-settings.mjs';
import {installHook} from '../bin/chill-hook.mjs';
import {contractMethods, requestViolations, responseViolations, schema} from '../test/codex-contract.mjs';
import {AppServer, fakeModel, hookTap, makeDir, makeHome, shapeDiff, shapeOf, shellCall, sleep, textItem, uuid} from './probe-codex-kit.mjs';

const fakeCodex = fileURLToPath(new URL('../test/fake-codex.mjs', import.meta.url));
const message = error => error?.message ?? String(error);

// Returns {checks, differences, validatedMethods, unvalidatedMethods}.
export async function runProtocol({codex, log}) {
  const checks = [];
  const check = (name, ok, detail = '') => { checks.push({name, ok: Boolean(ok), ...(detail ? {detail: String(detail)} : {})}); log(`${ok ? 'pass' : 'FAIL'}  ${name}${ok || !detail ? '' : `  (${String(detail).slice(0, 300)})`}`); };
  const attempt = async (name, run) => { try { await run(); } catch (error) { check(name, false, `threw: ${message(error)}`); } };

  const violations = new Map(), validated = new Set();
  const validate = (method, side, value) => {
    if (!contractMethods.includes(method)) return;
    validated.add(method);
    const bad = side === 'params' ? requestViolations(method, value) : responseViolations(method, value);
    if (bad.length) violations.set(method, [...(violations.get(method) ?? []), ...bad.map(text => `${side}: ${text}`)]);
  };
  const outcome = res => res.timeout ? {error: {message: 'timeout'}} : res.error ? {error: res.error} : {result: res.result};
  // Direct call on a server we started (stands in for Desktop). Returns {result} or {error}.
  const direct = async (server, method, params) => {
    validate(method, 'params', params);
    const reply = outcome(await server.call(method, params));
    if (reply.result) validate(method, 'response', reply.result);
    return reply;
  };
  // chill's own client, one app-server process per run, exactly as `withCodex` callers use it.
  const chill = run => withCodex(client => run(async (method, params) => {
    validate(method, 'params', params);
    try { const result = await client.request(method, params); validate(method, 'response', result); return {result}; }
    catch (error) { return {error: {message: message(error)}}; }
  }));
  const need = (reply, what) => { if (!reply.result) throw new Error(`${what}: ${reply.error?.message}`); return reply.result; };

  const home = makeHome('chill-codex-probe-', '');
  let slow = 0, mode = 'messages';
  const model = await fakeModel(async (request, index) => {
    if (mode === 'tool') return request.input.at(-1)?.type === 'function_call_output' ? [textItem('tool done')] : [shellCall('true')];
    if (slow) await sleep(slow);
    return ['a', 'b', 'c'].map(key => textItem(`${key}${index}`));
  });
  writeFileSync(join(home, 'config.toml'), model.config);
  const dataDirectory = makeDir('chill-codex-probe-data-'), project = makeDir('chill-codex-probe-project-');
  const env = {CHILL_AGENT_CODEX_PATH: codex.path, CODEX_HOME: home, HOME: home, FAKE_KEY: 'x', CHILL_AGENT_DATA_DIR: dataDirectory};
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const A = new AppServer(codex.path, home, 'A', {FAKE_KEY: 'x'});
  let fake;
  const differences = [];
  try {
    log(`codex ${codex.version}, disposable CODEX_HOME ${home}`);
    check('the committed protocol schema is from the installed Codex', schema.codex.version === codex.version, `fixture ${schema.codex.version}, installed ${codex.version}; run node scripts/update-codex-schema.mjs`);

    const init = outcome(await A.init());
    validate('initialize', 'params', A.initParams); if (init.result) validate('initialize', 'response', init.result);
    check('initialize accepts clientInfo with experimentalApi', init.result?.codexHome === home && typeof init.result.userAgent === 'string', JSON.stringify(init));
    const turnsDone = () => A.notes.filter(note => note.method === 'turn/completed').length;
    const waitTurns = async (count, timeout = 30000) => { const end = Date.now() + timeout; while (turnsDone() < count && Date.now() < end) await sleep(50); return turnsDone() >= count; };
    const textOf = turn => turn.items.filter(item => item.type === 'agentMessage').map(item => item.text);
    const userText = turn => turn.items.find(item => item.type === 'userMessage')?.content?.[0]?.text;
    const feedbackText = (n, extra = '') => `=== chill-agent · User Feedback ===\n[chill-agent:${uuid(900 + n)}]\n\nprobe ${n} 日本語 "quoted"\n\`\`\`json\n{"n": ${n}}\n\`\`\`${extra}`;
    const submission = (n, text = feedbackText(n)) => ({threadId, input: [{type: 'text', text, text_elements: []}], clientUserMessageId: uuid(n)});

    const started = outcome(await A.call('thread/start', {cwd: project}));
    const thread = started.result?.thread;
    check('thread/start creates a saved chat with a rollout path', thread && thread.ephemeral === false && typeof thread.path === 'string' && thread.status?.type === 'idle', JSON.stringify(started.error ?? thread?.status));
    const threadId = thread.id;

    await attempt('a chat before its first message', async () => {
      const early = await chill(call => call('thread/read', {threadId, includeTurns: false}));
      check('another process cannot read a chat before its first message', Boolean(early.error), 'thread/read answered');
      const turns = await direct(A, 'thread/turns/list', {threadId});
      check('thread/turns/list before the first message is an error', /not materialized/.test(turns.error?.message ?? ''), JSON.stringify(turns));
      const queue = await direct(A, 'thread/queue/list', {threadId});
      check('thread/queue/list before the first message is empty', queue.result?.data?.length === 0 && queue.result.nextCursor === null, JSON.stringify(queue));
    });

    await attempt('first message', async () => {
      const first = await direct(A, 'thread/queue/add', submission(1, 'first message typed in Desktop'));
      check('queue/add answers queuedSubmission with the input and clientUserMessageId', first.result?.queuedSubmission?.id && first.result.queuedSubmission.clientUserMessageId === uuid(1) && first.result.queuedSubmission.input[0].text === 'first message typed in Desktop', JSON.stringify(first));
      check('an idle chat runs a queued input as a turn', await waitTurns(1));
    });

    await attempt('another process queues', async () => {
      const status = await chill(call => call('thread/read', {threadId, includeTurns: false}));
      check('thread/read from another process reports the chat notLoaded and the same rollout path', status.result?.thread?.status?.type === 'notLoaded' && status.result.thread.path === thread.path, JSON.stringify(status.result?.thread?.status ?? status.error));
      for (const n of [2, 3]) {
        const added = await chill(call => call('thread/queue/add', submission(n)));
        check(`queue/add from another process (${n}) is accepted`, added.result?.queuedSubmission?.clientUserMessageId === uuid(n), JSON.stringify(added));
        check(`the long-lived process runs that input as a turn (${n})`, await waitTurns(n));
      }
      const seen = A.notes.filter(note => /^(turn|thread)\//.test(note.method)).map(note => note.method);
      check('the running process announces thread/status/changed, turn/started and turn/completed', ['thread/status/changed', 'turn/started', 'turn/completed'].every(method => seen.includes(method)));
      check('Codex asks the client for nothing while a turn only talks', A.serverRequests.length === 0, A.serverRequests.join());
    });

    let newest, all;
    await attempt('reading turns', async () => {
      const list = need(await chill(call => call('thread/turns/list', {threadId, itemsView: 'full'})), 'turns/list full');
      all = list.data;
      newest = all[0];
      check('turns/list lists the newest turn first', all.length === 3 && userText(all[0]).includes('probe 3') && userText(all[2]) === 'first message typed in Desktop', all.map(userText).join(' | '));
      check('a queued input comes back verbatim as the turn\'s userMessage, with its marker, text_elements and clientId', (() => { try { deepStrictEqual(newest.items[0].content, submission(3).input); return newest.items[0].clientId === uuid(3); } catch { return false; } })(), JSON.stringify(newest.items[0]));
      check('itemsView full lists every item oldest first (user message, then the agent messages)', JSON.stringify(newest.items.map(item => item.type)) === '["userMessage","agentMessage","agentMessage","agentMessage"]' && textOf(newest).join() === 'a3,b3,c3', JSON.stringify(newest.items.map(item => item.type)));
      const summary = need(await chill(call => call('thread/turns/list', {threadId, limit: 1})), 'turns/list default');
      const loaded = need(await chill(call => call('thread/turns/list', {threadId, limit: 1, itemsView: 'notLoaded'})), 'turns/list notLoaded');
      check('the default itemsView keeps only the first user message and the last agent message; notLoaded has no items', summary.data[0].itemsView === 'summary' && summary.data[0].items.length === 2 && loaded.data[0].items.length === 0 && loaded.data[0].itemsView === 'notLoaded', JSON.stringify([summary.data[0].itemsView, summary.data[0].items.length, loaded.data[0].items.length]));
      const asc = need(await chill(call => call('thread/turns/list', {threadId, sortDirection: 'asc'})), 'turns/list asc');
      check('sortDirection asc lists the oldest turn first', asc.data.map(turn => turn.id).join() === all.map(turn => turn.id).reverse().join());
      const page1 = need(await chill(call => call('thread/turns/list', {threadId, limit: 2})), 'turns/list limit');
      const page2 = need(await chill(call => call('thread/turns/list', {threadId, limit: 2, cursor: page1.nextCursor})), 'turns/list cursor');
      check('limit and cursor page through turns newest first and end with a null cursor', page1.data.length === 2 && typeof page1.nextCursor === 'string' && page2.data.length === 1 && page2.nextCursor === null && [...page1.data, ...page2.data].map(turn => turn.id).join() === all.map(turn => turn.id).join());
      const read = need(await chill(call => call('thread/read', {threadId, includeTurns: true})), 'thread/read includeTurns');
      check('thread/read includeTurns returns the turns with their items', read.thread.turns.length === 3 && read.thread.turns.every(turn => turn.items.some(item => item.type === 'userMessage')) && read.thread.turns.some(turn => turn.items.length === 4), JSON.stringify(read.thread.turns.map(turn => turn.items.length)));
      check('thread/read without includeTurns carries no turns', (await chill(call => call('thread/read', {threadId, includeTurns: false}))).result?.thread?.turns?.length === 0);
      check('turn startedAt and completedAt are Unix seconds', [newest.startedAt, newest.completedAt].every(value => Number.isInteger(value) && Math.abs(value - Date.now() / 1000) < 600) && newest.completedAt >= newest.startedAt, `${newest.startedAt} ${newest.completedAt}`);
    });

    await attempt('reading items', async () => {
      const items = need(await chill(call => call('thread/items/list', {threadId, turnId: newest.id})), 'items/list');
      check('items/list lists one turn\'s items oldest first, each as {turnId, item, startedAtMs, completedAtMs}', items.data.length === 4 && items.data.every(entry => entry.turnId === newest.id && entry.item && Number.isInteger(entry.startedAtMs)) && items.data[0].item.type === 'userMessage', JSON.stringify(items.data.map(entry => entry.item.type)));
      check('item startedAtMs is Unix milliseconds', Math.abs(items.data[0].startedAtMs - Date.now()) < 600000);
      const desc = need(await chill(call => call('thread/items/list', {threadId, turnId: newest.id, sortDirection: 'desc'})), 'items/list desc');
      check('sortDirection desc lists the last item first', desc.data[0].item.text === 'c3' && desc.data.at(-1).item.type === 'userMessage');
      const page1 = need(await chill(call => call('thread/items/list', {threadId, turnId: newest.id, limit: 3, sortDirection: 'desc'})), 'items/list limit');
      const page2 = need(await chill(call => call('thread/items/list', {threadId, turnId: newest.id, limit: 3, sortDirection: 'desc', cursor: page1.nextCursor})), 'items/list cursor');
      check('limit and cursor page through items and end with a null cursor', page1.data.length === 3 && typeof page1.nextCursor === 'string' && page2.data.length === 1 && page2.nextCursor === null && [...page1.data, ...page2.data].map(entry => entry.item.id).join() === desc.data.map(entry => entry.item.id).join());
      const whole = need(await chill(call => call('thread/items/list', {threadId})), 'items/list whole thread');
      check('items/list without a turnId lists every turn\'s items', whole.data.length === 12 && new Set(whole.data.map(entry => entry.turnId)).size === 3);
    });

    await attempt('rollout', async () => {
      const settings = await readTurnSettings(thread.path, newest.id);
      check('the rollout at thread.path has a turn_context with the turn\'s model and effort', settings?.model === 'fake-model' && settings.reasoning === 'medium', JSON.stringify(settings));
    });

    await attempt('verifyThread', async () => {
      check('chill\'s verifyThread accepts a used Desktop chat', (await verifyThread(threadId)).id === threadId);
      const ephemeral = need(await direct(A, 'thread/start', {cwd: project, ephemeral: true}), 'thread/start ephemeral').thread;
      check('chill\'s verifyThread rejects a chat that is not a saved Desktop chat', await verifyThread(ephemeral.id).then(() => false, () => true));
    });

    let queued = [];
    await attempt('queue while a turn runs', async () => {
      slow = 1500;
      const mark = A.notes.length;
      await chill(call => call('thread/queue/add', submission(4)));
      check('the first queued input starts at once', Boolean(await A.waitNote(note => note.method === 'turn/started', 15000, mark)));
      check('a running chat reports status active', (await chill(call => call('thread/read', {threadId, includeTurns: false}))).result?.thread?.status?.type === 'notLoaded' && (await direct(A, 'thread/read', {threadId, includeTurns: false})).result.thread.status.type === 'active');
      const latest = need(await chill(call => call('thread/turns/list', {threadId, limit: 1, itemsView: 'notLoaded'})), 'turns/list while running');
      const live = need(await direct(A, 'thread/turns/list', {threadId, limit: 1, itemsView: 'notLoaded'}), 'turns/list while running, in the running process');
      check('the running process reports its turn inProgress with completedAt null', live.data[0].status === 'inProgress' && live.data[0].completedAt === null && Number.isInteger(live.data[0].startedAt), JSON.stringify(live.data[0]));
      check('another process reports that live turn as interrupted, still with completedAt null (chill closes a turn only on completedAt)', latest.data[0].id === live.data[0].id && latest.data[0].status === 'interrupted' && latest.data[0].completedAt === null, JSON.stringify(latest.data[0]));
      for (const n of [5, 6, 7]) queued.push((await chill(call => call('thread/queue/add', submission(n)))).result?.queuedSubmission);
      const page1 = need(await chill(call => call('thread/queue/list', {threadId, limit: 2})), 'queue/list');
      const page2 = need(await chill(call => call('thread/queue/list', {threadId, limit: 2, cursor: page1.nextCursor})), 'queue/list cursor');
      check('queue/list keeps pending inputs in order with their clientUserMessageId, and pages by limit and cursor', page1.data.map(entry => entry.clientUserMessageId).join() === [5, 6].map(uuid).join() && typeof page1.nextCursor === 'string' && page2.data.length === 1 && page2.data[0].id === queued[2].id && page2.nextCursor === null, JSON.stringify([page1, page2]).slice(0, 200));
      check('the queued entry carries the exact input', JSON.stringify(page1.data[0].input) === JSON.stringify(submission(5).input));
      const removed = await chill(call => call('thread/queue/delete', {threadId, queuedSubmissionId: queued[0].id}));
      const again = await chill(call => call('thread/queue/delete', {threadId, queuedSubmissionId: queued[0].id}));
      check('queue/delete answers deleted true, then false once the entry is gone', removed.result?.deleted === true && again.result?.deleted === false, JSON.stringify([removed, again]));
      check('the rest of the queue drains into turns after the running one', await waitTurns(6, 30000), `${turnsDone()} turns done`);
      const queue = need(await chill(call => call('thread/queue/list', {threadId})), 'queue/list drained');
      const turns = need(await chill(call => call('thread/turns/list', {threadId, itemsView: 'full'})), 'turns/list drained').data;
      check('a deleted entry never runs and the queue ends empty', queue.data.length === 0 && turns.length === 6 && !turns.some(turn => userText(turn).includes('probe 5')), JSON.stringify(turns.map(userText)));
      check('turns started from the queue complete oldest to newest in queue order', turns.map(turn => userText(turn).match(/probe (\d)/)?.[1] ?? 'first').join() === '7,6,4,3,2,first', turns.map(turn => userText(turn).slice(0, 40)).join(' | '));
      slow = 0;
    });

    await attempt('hooks', async () => {
      const hookProject = makeDir('chill-codex-probe-hooks-');
      const file = await installHook(hookProject);
      const written = JSON.parse(readFileSync(file, 'utf8'));
      const trusted = project => direct(A, 'config/value/write', {keyPath: `projects."${project}".trust_level`, value: 'trusted', mergeStrategy: 'upsert'});
      check('the project trust level is writable through config/value/write', (await trusted(hookProject)).result?.status === 'ok');
      const listed = await direct(A, 'hooks/list', {cwds: [hookProject]});
      const entry = listed.result?.data?.[0], hook = entry?.hooks?.[0];
      const wanted = written.hooks.PostToolUse[0].hooks[0];
      check('hooks/list accepts the hooks.json chill\'s installHook writes, with no errors or warnings', entry?.hooks.length === 1 && entry.errors.length === 0 && entry.warnings.length === 0 && hook.source === 'project' && hook.eventName === 'postToolUse' && hook.matcher === '*' && hook.command === wanted.command && hook.timeoutSec === wanted.timeout && hook.statusMessage === wanted.statusMessage && hook.additionalContextLimit === wanted.additionalContextLimit, JSON.stringify(listed).slice(0, 400));
      check('a new hook is untrusted until the user trusts it', hook?.trustStatus === 'untrusted', hook?.trustStatus);

      const tap = hookTap(hookProject, wanted.command);
      writeFileSync(file, JSON.stringify({hooks: {PostToolUse: [{matcher: '*', hooks: [{...wanted, command: tap.command}]}]}}, null, 2));
      mode = 'tool';
      const hookThread = need(await direct(A, 'thread/start', {cwd: hookProject}), 'thread/start hooks').thread.id;
      const runTool = async n => { const before = turnsDone(); await direct(A, 'thread/queue/add', {...submission(20 + n, `run a tool ${n}`), threadId: hookThread}); return waitTurns(before + 1); };
      check('a turn with a tool call completes', await runTool(1));
      check('an untrusted hook does not run', tap.read().length === 0 && !A.notes.some(note => note.method === 'hook/started'), JSON.stringify(tap.read()).slice(0, 200));
      const relisted = (await direct(A, 'hooks/list', {cwds: [hookProject]})).result.data[0].hooks[0];
      const trust = await direct(A, 'config/value/write', {keyPath: `hooks.state."${relisted.key}".trusted_hash`, value: relisted.currentHash, mergeStrategy: 'upsert'});
      const afterTrust = (await direct(A, 'hooks/list', {cwds: [hookProject]})).result.data[0].hooks[0];
      check('config/value/write of hooks.state."<key>".trusted_hash trusts a hook', trust.result?.status === 'ok' && afterTrust.trustStatus === 'trusted', afterTrust.trustStatus);
      check('a chat that started before the hook was trusted keeps running without it', await runTool(2) && tap.read().length === 0);
      const mark = A.notes.length;
      const newThread = need(await direct(A, 'thread/start', {cwd: hookProject}), 'thread/start after trust').thread.id;
      const before = turnsDone();
      await direct(A, 'thread/queue/add', {...submission(30, 'run a tool 3'), threadId: newThread});
      check('a chat started after trusting completes', await waitTurns(before + 1));
      const runs = tap.read();
      check('a trusted hook runs once per tool call in a chat started after trusting', runs.length === 1 && A.notes.slice(mark).filter(note => note.method === 'hook/completed').length === 1, `${runs.length} runs`);
      const hookedTurn = need(await direct(A, 'thread/turns/list', {threadId: newThread, limit: 1}), 'hook turn').data[0];
      const input = runs[0]?.input ?? {};
      check('the hook receives hook_event_name PostToolUse, the chat id as session_id and the turn id as turn_id', input.hook_event_name === 'PostToolUse' && input.session_id === newThread && input.turn_id === hookedTurn.id && input.agent_id === undefined, JSON.stringify(Object.keys(input)));
      check('chill\'s hook command exits 0 and prints nothing when no feedback is pending', runs[0]?.code === 0 && runs[0].output === '', JSON.stringify(runs[0] && {code: runs[0].code, output: runs[0].output}));
      const completed = A.notes.slice(mark).find(note => note.method === 'hook/completed');
      check('Codex reports the hook run completed', completed?.params.run.status === 'completed' && completed.params.run.statusMessage === wanted.statusMessage, JSON.stringify(completed?.params.run));
      mode = 'messages';
    });

    await attempt('fake comparison', async () => {
      mode = 'messages';
      fake = await compareWithFake({A, chill, direct, threadId, slowSet: ms => { slow = ms; }, differences, log, project});
    });

    for (const method of contractMethods) {
      if (!validated.has(method)) { log(`note  ${method} was not exercised (needs a signed-in account; the connection part covers it)`); continue; }
      check(`schema: every ${method} request and response matches test/fixtures/codex-app-server-schema.json`, !violations.has(method), (violations.get(method) ?? []).slice(0, 3).join('; '));
    }
  } finally {
    await A.stop(); await fake?.stop(); await model.close();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  return {checks, differences, validatedMethods: [...validated].sort(), unvalidatedMethods: contractMethods.filter(method => !validated.has(method))};
}

// Replays the same read and queue requests on test/fake-codex.mjs, seeded with the real turns, and lists where the answers differ.
async function compareWithFake({A, chill, direct, threadId, slowSet, differences, log, project}) {
  const root = makeDir('chill-codex-probe-fake-');
  const outcomes = {real: [], fake: []};
  const sequence = async (call, c) => {
    await call('turns/list, chat with no messages', 'thread/turns/list', {threadId: c.fresh});
    await call('thread/read, chat with no messages', 'thread/read', {threadId: c.fresh, includeTurns: false});
    await call('queue/list, empty queue', 'thread/queue/list', {threadId: c.fresh});
    await call('thread/read', 'thread/read', {threadId: c.main, includeTurns: false});
    await call('thread/read includeTurns', 'thread/read', {threadId: c.main, includeTurns: true});
    await call('turns/list default', 'thread/turns/list', {threadId: c.main});
    await call('turns/list limit 1', 'thread/turns/list', {threadId: c.main, limit: 1});
    const page = await call('turns/list limit 2', 'thread/turns/list', {threadId: c.main, limit: 2});
    await call('turns/list limit 2, next page', 'thread/turns/list', {threadId: c.main, limit: 2, cursor: page.result?.nextCursor});
    await call('turns/list asc', 'thread/turns/list', {threadId: c.main, sortDirection: 'asc'});
    await call('turns/list notLoaded', 'thread/turns/list', {threadId: c.main, limit: 1, itemsView: 'notLoaded'});
    await call('turns/list full', 'thread/turns/list', {threadId: c.main, limit: 1, itemsView: 'full'});
    const turnId = (await call('turn id', 'thread/turns/list', {threadId: c.main, limit: 1, itemsView: 'full'})).result?.data?.[0]?.id;
    await call('items/list one turn', 'thread/items/list', {threadId: c.main, turnId});
    const items = await call('items/list desc limit 3', 'thread/items/list', {threadId: c.main, turnId, sortDirection: 'desc', limit: 3});
    await call('items/list desc, next page', 'thread/items/list', {threadId: c.main, turnId, sortDirection: 'desc', limit: 3, cursor: items.result?.nextCursor});
    await call('items/list whole thread', 'thread/items/list', {threadId: c.main});
    await c.busy?.();
    const added = await call('queue/add', 'thread/queue/add', {threadId: c.main, ...c.submission(31)});
    await call('queue/add, second', 'thread/queue/add', {threadId: c.main, ...c.submission(32)});
    await call('queue/list', 'thread/queue/list', {threadId: c.main});
    const queuePage = await call('queue/list limit 1', 'thread/queue/list', {threadId: c.main, limit: 1});
    await call('queue/list limit 1, next page', 'thread/queue/list', {threadId: c.main, limit: 1, cursor: queuePage.result?.nextCursor});
    await call('queue/delete', 'thread/queue/delete', {threadId: c.main, queuedSubmissionId: added.result?.queuedSubmission?.id});
    await call('queue/delete, again', 'thread/queue/delete', {threadId: c.main, queuedSubmissionId: added.result?.queuedSubmission?.id});
    await call('model/list', 'model/list', {});
  };
  const submission = n => ({input: [{type: 'text', text: `compare ${n}`, text_elements: []}], clientUserMessageId: uuid(n)});
  const keep = (side, label, method, reply) => { outcomes[side].push({label, method, ...(reply.result ? {shape: shapeOf(reply.result), facts: facts(reply.result)} : {error: reply.error.message})}); return reply; };
  const facts = result => result.data ? {count: result.data.length, next: result.nextCursor != null, items: result.data.map(entry => entry.items ? entry.items.length : entry.item?.type ?? entry.input?.length)}
    : result.thread ? {status: result.thread.status.type, turns: result.thread.turns.length} : result.deleted !== undefined ? {deleted: result.deleted} : {};

  const freshReal = (await direct(A, 'thread/start', {cwd: project})).result.thread.id;
  await chill(call => sequence(async (label, method, params) => keep('real', label, method, await call(method, params)), {
    fresh: freshReal, main: threadId, submission,
    busy: async () => { slowSet(1500); const mark = A.notes.length; await direct(A, 'thread/queue/add', {threadId, ...submission(30)}); await A.waitNote(note => note.method === 'turn/started', 15000, mark); },
  }));
  slowSet(0);
  const turns = (await chill(call => call('thread/turns/list', {threadId, itemsView: 'full', limit: 50}))).result.data;
  const entries = (await chill(call => call('thread/items/list', {threadId, limit: 200}))).result.data;
  const items = {}; for (const entry of entries) (items[entry.turnId] ??= []).push(entry);
  writeFileSync(join(root, 'fake-history.json'), JSON.stringify({turns: turns.filter(turn => turn.completedAt !== null), items}));
  const fake = new AppServer(fakeCodex, root, 'fake', {CHILL_AGENT_DATA_DIR: root});
  await fake.init();
  await sequence(async (label, method, params) => keep('fake', label, method, outcomeOf(await fake.call(method, params))), {fresh: 'fresh-chat', main: threadId, submission});
  for (const real of outcomes.real) {
    if (real.label === 'turn id') continue;
    const other = outcomes.fake.find(entry => entry.label === real.label);
    if (!other) continue;
    const lines = [];
    if (real.error || other.error) { if (Boolean(real.error) !== Boolean(other.error)) lines.push(`real ${real.error ? `error "${real.error}"` : 'answers'}, fake ${other.error ? `error "${other.error}"` : 'answers'}`); }
    else {
      lines.push(...shapeDiff(real.shape, other.shape));
      if (JSON.stringify(real.facts) !== JSON.stringify(other.facts)) lines.push(`behavior: real ${JSON.stringify(real.facts)}, fake ${JSON.stringify(other.facts)}`);
    }
    if (lines.length) { differences.push({request: real.label, method: real.method, differences: lines}); log(`diff  ${real.label} (${real.method}): ${lines.join('; ')}`); }
  }
  differences.push(...[
    {request: 'queued input while the chat is idle', method: 'thread/queue/add', differences: ['real: Codex starts a turn from the queue by itself, and announces thread/queue/changed, thread/status/changed and turn/started; fake: the entry stays in the queue forever, no notification is ever sent']},
    {request: 'a second app-server process', method: '*', differences: ['real: another process sees thread status notLoaded and sees the queue and turns persisted by the first; fake: one shared file, never differs']},
    {request: 'a chat with no turns yet', method: 'thread/start', differences: ['real: the chat exists only in its own process until the first message; fake: has no thread/start']},
  ]);
  log(`${differences.length} difference${differences.length === 1 ? '' : 's'} between the real answers and test/fake-codex.mjs`);
  return fake;
}
const outcomeOf = res => res.timeout ? {error: {message: 'timeout'}} : res.error ? {error: res.error} : {result: res.result};
