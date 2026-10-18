#!/usr/bin/env node
// A fake `codex app-server`. Every request and response is held to the real protocol (test/codex-contract.mjs).
// A violation is answered with a JSON-RPC error that names it and is recorded for test/isolate-env.mjs to fail the run.
import {createInterface} from 'node:readline';
import {appendFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {join, resolve} from 'node:path';
import {codexModel, codexThread, contractError, contractMethods, recordViolation, requestViolations, responseViolations} from './codex-contract.mjs';
if (process.argv.includes('--version')) { console.log('codex-cli 0.158.0-test'); process.exit(0); }
const root = process.env.CHILL_AGENT_DATA_DIR;
await mkdir(root, {recursive: true});
const path = join(root, 'fake-queue.json');
// Entries keep the `threadId` they were queued on; the protocol never shows it.
let queue = [];
try { queue = JSON.parse(await readFile(path, 'utf8')); } catch {}
const queued = ({id, clientUserMessageId, input}) => ({id, clientUserMessageId, input});
const send = message => console.log(JSON.stringify(message));
const rpcError = (code, message) => Object.assign(new Error(message), {code});
const readHistory = async () => { try { return JSON.parse(await readFile(join(root, 'fake-history.json'), 'utf8')); } catch { return {}; } };
// fake-history.json is a script, not a payload: turns newest first and items oldest first (the protocol defaults for `sortDirection`), and a turn may omit `items`.
const inOrder = (list, direction, authored) => direction === authored ? list : [...list].reverse();
const paged = (list, {limit, cursor}) => {
  const start = cursor == null ? 0 : Number(cursor), size = limit ?? 25;
  if (!Number.isInteger(start) || start < 0) throw rpcError(-32600, `Invalid cursor: ${cursor}`);
  return {data: list.slice(start, start + size), nextCursor: start + size < list.length ? String(start + size) : null};
};
const rateLimits = {limitId: 'codex', limitName: 'Codex', primary: {usedPercent: 12, windowDurationMins: 10080, resetsAt: 1791595319}, secondary: null, credits: {hasCredits: true, unlimited: false, balance: '62500'}};

const handlers = {
  initialize: () => ({userAgent: 'Fake Codex', codexHome: resolve(root), platformFamily: 'unix', platformOs: 'macos'}),
  async 'thread/read'({threadId, includeTurns}) {
    if (threadId.endsWith('999999999999')) throw rpcError(-32600, 'Chat not found.');
    const history = await readHistory();
    if (history.fail) throw rpcError(-32600, 'History unavailable');
    if (process.env.CHILL_TEST_READ_DELAY) await delay(Number(process.env.CHILL_TEST_READ_DELAY));
    return {thread: codexThread({id: threadId, cwd: resolve(root), model: history.model || 'gpt-6-astra', reasoningEffort: history.reasoningEffort || 'medium', status: history.status || {type: 'notLoaded'}, turns: includeTurns ? inOrder(history.turns || [], 'asc', 'desc').map(turn => ({items: [], ...turn})) : []})};
  },
  async 'thread/turns/list'({itemsView, sortDirection, ...page}) {
    const history = await readHistory();
    if (history.fail) throw rpcError(-32600, 'History unavailable');
    const {data, nextCursor} = paged(inOrder(history.turns || [], sortDirection ?? 'desc', 'desc'), page);
    return {data: data.map(turn => itemsView === 'notLoaded' ? {...turn, items: [], itemsView} : {items: [], ...turn}), nextCursor};
  },
  async 'thread/items/list'({turnId, sortDirection, ...page}) {
    const history = await readHistory();
    if (history.fail) throw rpcError(-32600, 'History unavailable');
    const entries = turnId == null ? inOrder(history.turns || [], 'asc', 'desc').flatMap(turn => history.items?.[turn.id] || []) : history.items?.[turnId] || [];
    return paged(inOrder(entries, sortDirection ?? 'asc', 'asc'), page);
  },
  'model/list': ({limit}) => ({data: [codexModel({id: 'gpt-6-astra', displayName: 'GPT-6 Astra', isDefault: true})].slice(0, limit ?? 25), nextCursor: null}),
  async 'account/rateLimits/read'() {
    if ((await readHistory()).usageFail) throw rpcError(-32600, 'Usage unavailable');
    return {accountId: 'private-account', rateLimits, rateLimitsByLimitId: {codex: rateLimits}};
  },
  'thread/queue/list': ({threadId, ...page}) => paged(queue.filter(entry => entry.threadId === threadId).map(queued), page),
  async 'thread/queue/add'({threadId, input, clientUserMessageId}) {
    if (process.env.CHILL_TEST_QUEUE_DELAY) await delay(Number(process.env.CHILL_TEST_QUEUE_DELAY));
    const entry = {id: `queue-${queue.length + 1}`, input, clientUserMessageId, threadId};
    queue.push(entry); await writeFile(path, JSON.stringify(queue));
    if (process.env.CHILL_TEST_DROP_AFTER_ADD === '1') process.exit(0);
    return {queuedSubmission: queued(entry)};
  },
  async 'thread/queue/delete'({threadId, queuedSubmissionId}) {
    if (process.env.CHILL_TEST_START_ON_DELETE === '1') {
      const entry = queue.find(e => e.id === queuedSubmissionId);
      if (entry) {
        const id = '00000000-0000-0000-0000-000000000003', item = {type: 'userMessage', id: 'item-1', content: entry.input};
        queue = queue.filter(e => e !== entry); await writeFile(path, JSON.stringify(queue));
        await writeFile(join(root, 'fake-history.json'), JSON.stringify({turns: [{id, completedAt: null, status: 'inProgress', items: [item]}], items: {[id]: [{turnId: id, item}]}}));
        return {deleted: false};
      }
    }
    if (process.env.CHILL_TEST_DELETE_FAIL === '1') throw rpcError(-32600, 'Queue removal unavailable');
    const before = queue.length;
    queue = queue.filter(entry => entry.threadId !== threadId || entry.id !== queuedSubmissionId);
    await writeFile(path, JSON.stringify(queue));
    if (process.env.CHILL_TEST_DROP_AFTER_DELETE === '1') process.exit(0);
    return {deleted: queue.length < before};
  },
};
for (const method of Object.keys(handlers)) if (!contractMethods.includes(method)) throw new Error(`fake-codex implements ${method}, which is not in the protocol fixture`);

const violation = (id, method, side, list) => {
  const text = contractError(method, side, list);
  recordViolation(text);
  send({id, error: {code: side === 'request' ? -32602 : -32603, message: text}});
};
let chain = Promise.resolve();
createInterface({input: process.stdin}).on('line', line => {
  chain = chain.then(async () => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    await appendFile(join(root, 'fake-requests.jsonl'), JSON.stringify(request) + '\n');
    const bad = requestViolations(request.method, request.params);
    if (bad.length) return violation(request.id, request.method, 'request', bad);
    const handler = handlers[request.method];
    if (!handler) { send({id: request.id, error: {code: -32601, message: `Unsupported method ${request.method}`}}); return; }
    let result;
    try { result = await handler(request.params ?? {}); } catch (error) { send({id: request.id, error: {code: error.code ?? -32603, message: error.message}}); return; }
    const wrong = responseViolations(request.method, result);
    if (wrong.length) return violation(request.id, request.method, 'response', wrong);
    send({id: request.id, result});
  });
});
