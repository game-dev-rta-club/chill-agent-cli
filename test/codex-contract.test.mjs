import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {codexThread, contractMethods, contractStub, requestViolations, responseViolations, schema} from './codex-contract.mjs';
import {compile} from './json-schema.mjs';
import {METHODS} from '../scripts/update-codex-schema.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const fake = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));

async function sources(directory) {
  const files = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sources(path));
    else if (entry.name.endsWith('.mjs')) files.push(path);
  }
  return files;
}

test('every app-server method chill-agent calls is in the protocol fixture and the update script', async () => {
  const called = new Set();
  for (const file of [...await sources(join(repository, 'lib')), ...await sources(join(repository, 'bin')), join(repository, 'server.mjs')])
    for (const [, method] of (await readFile(file, 'utf8')).matchAll(/\.request\(\s*['"`]([^'"`]+)['"`]/g)) called.add(method);
  assert.ok(called.size >= 8, 'the scan finds chill-agent Codex requests');
  assert.deepEqual([...called].filter(method => !contractMethods.includes(method)), [], 'add the method to METHODS in scripts/update-codex-schema.mjs and rerun it');
  assert.deepEqual([...contractMethods].sort(), Object.keys(METHODS).sort(), 'the fixture was generated from the current METHODS list');
});

test('the validator reports required, unknown, mistyped and ambiguous values and refuses keywords it does not implement', () => {
  const validate = compile({definitions: {Pair: {properties: {a: {type: 'integer', minimum: 0}, b: {anyOf: [{enum: ['x']}, {type: 'null'}]}}, required: ['a'], type: 'object'}}});
  const pair = {$ref: '#/definitions/Pair'};
  assert.deepEqual(validate(pair, {a: 1, b: null}), []);
  assert.match(validate(pair, {})[0], /\$: missing required property "a"/);
  assert.match(validate(pair, {a: 1, c: 2})[0], /\$\.c: property is not in the schema/);
  assert.match(validate(pair, {a: 1.5})[0], /\$\.a: expected integer/);
  assert.match(validate(pair, {a: -1})[0], /below the minimum/);
  assert.match(validate(pair, {a: 1, b: 'y'})[0], /\$\.b: matches none of the anyOf variants/);
  assert.match(validate({oneOf: [{type: 'string'}, {minLength: 1}]}, 'x')[0], /matches 2 of the oneOf variants/);
  assert.throws(() => compile({definitions: {Bad: {pattern: '^a'}}}), /Unsupported JSON Schema keyword "pattern"/);
  assert.throws(() => compile({definitions: {Bad: {properties: {a: {format: 'date-time'}}}}}), /Unsupported JSON Schema format/);
});

test('the protocol fixture accepts a real-shaped exchange and names what a wrong one breaks', () => {
  const thread = codexThread({id: 't'});
  assert.deepEqual(responseViolations('thread/read', {thread}), []);
  assert.deepEqual(requestViolations('thread/turns/list', {threadId: 't', limit: 1, itemsView: 'notLoaded'}), []);
  const {sessionId, ...partial} = thread;
  assert.match(responseViolations('thread/read', {thread: partial})[0], /\$result\.thread: missing required property "sessionId"/);
  assert.match(responseViolations('thread/queue/add', {queuedSubmission: {id: 'q', clientUserMessageId: 'm', input: [], threadId: 't'}})[0], /threadId: property is not in the schema/);
  assert.match(requestViolations('thread/queue/list', {threadId: 't', limti: 1})[0], /limti/);
  assert.match(requestViolations('thread/turns/list', {threadId: 't', sortDirection: 'newest'})[0], /sortDirection/);
  assert.match(requestViolations('thread/unknown', {})[0], /not in the protocol fixture/);
  assert.equal(schema.methods['thread/read'].params.$ref, '#/definitions/v2/ThreadReadParams');
});

test('an inline Codex stub is held to the protocol and records what it breaks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chill-contract-test-')), log = join(directory, 'log'), old = process.env.CHILL_TEST_CONTRACT_LOG;
  process.env.CHILL_TEST_CONTRACT_LOG = log;
  try {
    const stub = contractStub(async method => method === 'thread/read' ? {thread: {id: 't'}} : {data: [], nextCursor: null});
    await assert.rejects(stub.request('thread/queue/list', {threadId: 't', limit: 'many'}), /limit/);
    await assert.rejects(stub.request('thread/read', {threadId: 't'}), /missing required property "cliVersion"/);
    assert.deepEqual(await stub.request('thread/queue/list', {threadId: 't'}), {data: [], nextCursor: null});
    assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 2);
  } finally { if (old === undefined) delete process.env.CHILL_TEST_CONTRACT_LOG; else process.env.CHILL_TEST_CONTRACT_LOG = old; }
});

async function talk(directory, requests, env = {}) {
  const log = join(directory, 'violations.log');
  const child = spawn(process.execPath, [fake], {env: {...process.env, CHILL_AGENT_DATA_DIR: directory, CHILL_TEST_CONTRACT_LOG: log, ...env}, stdio: ['pipe', 'pipe', 'inherit']});
  const replies = new Map();
  let buffer = '';
  const done = new Promise(resolve => child.stdout.on('data', chunk => {
    buffer += chunk;
    for (const line of buffer.split('\n').slice(0, -1)) { const message = JSON.parse(line); replies.set(message.id, message); }
    buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
    if (replies.size === requests.length) resolve();
  }));
  requests.forEach(([method, params], index) => child.stdin.write(`${JSON.stringify({id: index + 1, method, params})}\n`));
  await done;
  child.kill();
  return {replies: requests.map((_, index) => replies.get(index + 1)), violations: await readFile(log, 'utf8').catch(() => '')};
}

test('the fake Codex rejects a request or a response that breaks the protocol, naming the violation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chill-fake-contract-'));
  await writeFile(join(directory, 'fake-history.json'), JSON.stringify({turns: [{id: 'turn'}]}));
  const {replies, violations} = await talk(directory, [
    ['thread/queue/list', {threadId: 't', limti: 1}],
    ['thread/turns/list', {threadId: 't', limit: 1, itemsView: 'notLoaded'}],
    ['thread/getTheMeaning', {}],
    ['initialize', {clientInfo: {name: 'x', version: '1'}}],
  ]);
  assert.match(replies[0].error.message, /thread\/queue\/list request.*limti: property is not in the schema/);
  assert.match(replies[1].error.message, /thread\/turns\/list response.*missing required property "status"/);
  assert.match(replies[2].error.message, /thread\/getTheMeaning request.*not in the protocol fixture/);
  assert.ok(replies[3].result.codexHome);
  assert.equal(violations.trim().split('\n').length, 3);
});

test('the fake Codex orders and pages like Codex: turns newest first, items oldest first, limit and cursor continue', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chill-fake-paging-'));
  const turn = id => ({id, status: 'completed', completedAt: 1, items: []});
  const entry = (turnId, n) => ({turnId, item: {type: 'agentMessage', id: `${turnId}-${n}`, text: `${n}`}});
  await writeFile(join(directory, 'fake-history.json'), JSON.stringify({turns: [turn('c'), turn('b'), turn('a')], items: {a: [1, 2, 3].map(n => entry('a', n))}}));
  const {replies} = await talk(directory, [
    ['thread/turns/list', {threadId: 't', limit: 2, itemsView: 'full'}],
    ['thread/turns/list', {threadId: 't', limit: 2, cursor: '2', itemsView: 'full'}],
    ['thread/turns/list', {threadId: 't', sortDirection: 'asc', itemsView: 'full'}],
    ['thread/items/list', {threadId: 't', turnId: 'a', limit: 2}],
    ['thread/items/list', {threadId: 't', turnId: 'a', sortDirection: 'desc'}],
  ]);
  assert.deepEqual(replies[0].result.data.map(t => t.id), ['c', 'b']);
  assert.equal(replies[0].result.nextCursor, '2');
  assert.deepEqual(replies[1].result.data.map(t => t.id), ['a']);
  assert.equal(replies[1].result.nextCursor, null);
  assert.deepEqual(replies[2].result.data.map(t => t.id), ['a', 'b', 'c']);
  assert.deepEqual(replies[3].result.data.map(e => e.item.id), ['a-1', 'a-2']);
  assert.deepEqual(replies[4].result.data.map(e => e.item.id), ['a-3', 'a-2', 'a-1']);
});

test('queued submissions leave the fake without the thread they were queued on', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chill-fake-queue-'));
  await writeFile(join(directory, 'fake-history.json'), JSON.stringify({turns: [{id: 'busy', status: 'inProgress', completedAt: null}]}));
  const {replies} = await talk(directory, [
    ['thread/queue/add', {threadId: 't1', clientUserMessageId: 'm1', input: [{type: 'text', text: 'one', text_elements: []}]}],
    ['thread/queue/add', {threadId: 't2', clientUserMessageId: 'm2', input: [{type: 'text', text: 'two', text_elements: []}]}],
    ['thread/queue/list', {threadId: 't1', limit: 100}],
  ]);
  assert.deepEqual(Object.keys(replies[0].result.queuedSubmission).sort(), ['clientUserMessageId', 'id', 'input']);
  assert.deepEqual(replies[2].result.data.map(e => e.clientUserMessageId), ['m1']);
});

test('the fake answers chill as real Codex answers a second process beside Desktop', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chill-fake-desktop-'));
  const input = text => ({threadId: 't', clientUserMessageId: text, input: [{type: 'text', text, text_elements: []}]});
  const before = (await talk(directory, [['thread/read', {threadId: 't'}], ['thread/turns/list', {threadId: 't'}], ['thread/queue/list', {threadId: 't'}]])).replies;
  assert.deepEqual(before.map(r => r.error?.message), ['thread not loaded: t', 'thread not loaded: t', 'failed to read thread: invalid thread-store request: no rollout found for thread id t'], 'a chat is invisible before its first turn');
  await writeFile(join(directory, 'fake-history.json'), JSON.stringify({status: {type: 'active', activeFlags: []}, turns: [{id: 'done', status: 'completed', completedAt: 1}]}));
  const idle = (await talk(directory, [['thread/queue/add', input('one')], ['thread/queue/add', input('two')], ['thread/queue/list', {threadId: 't'}], ['thread/turns/list', {threadId: 't', itemsView: 'full'}], ['thread/read', {threadId: 't'}]])).replies;
  assert.deepEqual(idle[2].result.data.map(e => e.clientUserMessageId), ['two'], 'an idle chat runs the first input at once; the second waits for it');
  const [running] = idle[3].result.data;
  assert.equal(running.items[0].clientId, 'one');
  assert.deepEqual([running.status, running.completedAt], ['interrupted', null], 'a live turn reads interrupted with completedAt null');
  assert.equal(idle[4].result.thread.status.type, 'notLoaded', 'the chat reads notLoaded, whatever Desktop shows');
  const history = JSON.parse(await readFile(join(directory, 'fake-history.json'), 'utf8'));
  Object.assign(history.turns[0], {status: 'completed', completedAt: 2});
  await writeFile(join(directory, 'fake-history.json'), JSON.stringify(history));
  const after = (await talk(directory, [['thread/queue/list', {threadId: 't'}], ['thread/turns/list', {threadId: 't', limit: 1}]])).replies;
  assert.deepEqual([after[0].result.data, after[1].result.data[0].items[0].clientId], [[], 'two'], 'the queue drains into the next turn when the chat is idle');
  const stopped = JSON.parse(await readFile(join(directory, 'fake-history.json'), 'utf8'));
  Object.assign(stopped.turns[0], {status: 'interrupted', completedAt: 3});
  await writeFile(join(directory, 'fake-history.json'), JSON.stringify(stopped));
  const held = (await talk(directory, [['thread/queue/add', input('three')], ['thread/queue/list', {threadId: 't'}]])).replies;
  assert.deepEqual(held[1].result.data.map(e => e.clientUserMessageId), ['three'], 'a stopped chat keeps its queue until Desktop starts a turn');
});
