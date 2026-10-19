#!/usr/bin/env node
// A fake `codex app-server`. Every request and response is held to the real protocol (test/codex-contract.mjs).
// A violation is answered with a JSON-RPC error that names it and is recorded for test/isolate-env.mjs to fail the run.
// It answers as the real one does to chill, which always runs in a second process beside Codex Desktop
// (verified by scripts/probe-codex.mjs): the chat reads notLoaded, a live turn reads interrupted with
// completedAt null, a chat is invisible before its first turn, and an idle chat starts a turn from its queue.
import {createInterface} from 'node:readline';
import {appendFile, mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {join, resolve} from 'node:path';
import {desktopFiles, liveTurn} from './fake-codex-desktop.mjs';
import {codexModel, codexThread, contractError, contractMethods, recordViolation, requestViolations, responseViolations} from './codex-contract.mjs';
if (process.argv.includes('--version')) { console.log('codex-cli 0.158.0-test'); process.exit(0); }
const root = process.env.CHILL_AGENT_DATA_DIR;
await mkdir(root, {recursive: true});
const desktop = desktopFiles(root);
// Entries keep the `threadId` they were queued on; the protocol never shows it.
const queued = ({id, clientUserMessageId, input}) => ({id, clientUserMessageId, input});
const send = message => console.log(JSON.stringify(message));
const rpcError = (code, message) => Object.assign(new Error(message), {code});
const readHistory = desktop.history;
// Only the process that runs a turn sees it inProgress.
const seen = turn => liveTurn(turn) && turn.status === 'inProgress' ? {...turn, status: 'interrupted'} : turn;
const unread = threadId => rpcError(-32600, `thread not loaded: ${threadId}`);
// fake-history.json is a script, not a payload: turns newest first and items oldest first (the protocol defaults for `sortDirection`), and a turn may omit `items`.
const inOrder = (list, direction, authored) => direction === authored ? list : [...list].reverse();
const paged = (list, {limit, cursor}) => {
  const start = cursor == null ? 0 : Number(cursor), size = limit ?? 25;
  if (!Number.isInteger(start) || start < 0) throw rpcError(-32600, `Invalid cursor: ${cursor}`);
  return {data: list.slice(start, start + size), nextCursor: start + size < list.length ? String(start + size) : null};
};
// Codex's default itemsView is `summary`: the first user message and the last agent message only (verified by scripts/probe-codex.mjs).
const shownItems = (items, view) => view === 'full' ? items : view === 'notLoaded' ? [] : [items.find(item => item.type === 'userMessage'), items.findLast(item => item.type === 'agentMessage')].filter(Boolean);
const rateLimits = {limitId: 'codex', limitName: 'Codex', primary: {usedPercent: 12, windowDurationMins: 10080, resetsAt: 1791595319}, secondary: null, credits: {hasCredits: true, unlimited: false, balance: '62500'}};

const handlers = {
  initialize: () => ({userAgent: 'Fake Codex', codexHome: resolve(root), platformFamily: 'unix', platformOs: 'macos'}),
  async 'thread/read'({threadId, includeTurns}) {
    if (threadId.endsWith('999999999999')) throw rpcError(-32600, 'Chat not found.');
    const history = await readHistory();
    if (history.fail) throw rpcError(-32600, 'History unavailable');
    if (!history.turns?.length) throw unread(threadId);
    if (process.env.CHILL_TEST_READ_DELAY) await delay(Number(process.env.CHILL_TEST_READ_DELAY));
    return {thread: codexThread({id: threadId, cwd: resolve(root), model: history.model || 'gpt-6-astra', reasoningEffort: history.reasoningEffort || 'medium', status: {type: 'notLoaded'}, turns: includeTurns ? inOrder(history.turns, 'asc', 'desc').map(turn => ({items: [], ...seen(turn)})) : []})};
  },
  async 'thread/turns/list'({threadId, itemsView = 'summary', sortDirection, ...page}) {
    const history = await readHistory();
    if (history.fail) throw rpcError(-32600, 'History unavailable');
    if (!history.turns?.length) throw unread(threadId);
    const {data, nextCursor} = paged(inOrder(history.turns, sortDirection ?? 'desc', 'desc'), page);
    return {data: data.map(turn => ({...seen(turn), items: shownItems(turn.items ?? [], itemsView), itemsView})), nextCursor};
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
  async 'thread/queue/list'({threadId, ...page}) {
    if (!(await readHistory()).turns?.length) throw rpcError(-32600, `failed to read thread: invalid thread-store request: no rollout found for thread id ${threadId}`);
    return paged((await desktop.queue()).filter(entry => entry.threadId === threadId).map(queued), page);
  },
  async 'thread/queue/add'({threadId, input, clientUserMessageId}) {
    if (process.env.CHILL_TEST_QUEUE_DELAY) await delay(Number(process.env.CHILL_TEST_QUEUE_DELAY));
    const queue = await desktop.queue(), entry = {id: `queue-${randomUUID()}`, input, clientUserMessageId, threadId};
    await desktop.writeQueue([...queue, entry]);
    if (process.env.CHILL_TEST_DROP_AFTER_ADD === '1') process.exit(0);
    await desktop.runQueue(threadId);
    return {queuedSubmission: queued(entry)};
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
    if (request.params?.threadId) await desktop.runQueue(request.params.threadId);
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
