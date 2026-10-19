// The Codex Desktop chat behind test/fake-codex.mjs, as chill sees it from its own app-server process
// (verified by scripts/probe-codex.mjs). Tests change the chat here, as Desktop and its model would.
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

const read = async (file, fallback) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; } };
const now = () => Math.floor(Date.now() / 1000);
const userMessage = (input, clientId) => ({type: 'userMessage', id: randomUUID(), content: input, ...(clientId ? {clientId} : {})});
export const liveTurn = turn => Boolean(turn) && turn.completedAt == null;

// fake-history.json holds the turns newest first; fake-queue.json the inputs waiting, each with its threadId.
export function desktopFiles(root) {
  const historyPath = join(root, 'fake-history.json'), queuePath = join(root, 'fake-queue.json');
  const files = {
    history: () => read(historyPath, {}),
    queue: () => read(queuePath, []),
    writeHistory: history => writeFile(historyPath, JSON.stringify(history)),
    writeQueue: queue => writeFile(queuePath, JSON.stringify(queue)),
    // Desktop runs the next queued input as soon as the chat is idle, but not after its turn was stopped.
    async runQueue(threadId) {
      const [history, queue] = await Promise.all([files.history(), files.queue()]);
      const next = queue.findIndex(entry => entry.threadId === threadId), [latest] = history.turns || [];
      if (next === -1 || history.fail || liveTurn(latest) || latest?.status === 'interrupted') return;
      const [entry] = queue.splice(next, 1);
      await files.writeQueue(queue);
      const turn = {id: randomUUID(), status: 'inProgress', startedAt: now(), completedAt: null, items: [userMessage(entry.input, entry.clientUserMessageId)]};
      await files.writeHistory({...history, turns: [turn, ...(history.turns || [])]});
    },
  };
  return files;
}

// Every message chill sent the chat, oldest first: those Desktop already ran, then those still queued.
export async function sentTo(root, threadId) {
  const files = desktopFiles(root), [history, queue] = await Promise.all([files.history(), files.queue()]);
  const ran = (history.turns || []).filter(turn => turn.items?.[0]?.clientId).reverse().map(turn => turn.items[0].content);
  return [...ran, ...queue.filter(entry => entry.threadId === threadId).map(entry => entry.input)].map(input => input[0].text);
}
// A chat that has had its first message, so chill can see it. A test may add to the history it writes.
export const usedChat = (root, history = {}) => desktopFiles(root).writeHistory({...history, turns: [...(history.turns || []), {id: randomUUID(), status: 'completed', startedAt: now(), completedAt: now(), items: [userMessage([{type: 'text', text: 'Start', text_elements: []}])]}]});

// Desktop's internal IPC at CODEX_HOME/ipc/ipc.sock (lib/desktop-settings.mjs): `methods` answers each request by name.
export async function serveDesktopIPC(codexHome, methods) {
  const directory = join(codexHome, 'ipc');
  await mkdir(directory, {recursive: true, mode: 0o700});
  await rm(join(directory, 'ipc.sock'), {force: true});
  const server = createServer(socket => {
    let buffer = Buffer.alloc(0);
    const send = message => { const body = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4); header.writeUInt32LE(body.length); socket.write(Buffer.concat([header, body])); };
    socket.on('error', () => {});
    socket.on('data', async chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
        const size = buffer.readUInt32LE(), request = JSON.parse(buffer.subarray(4, size + 4));
        buffer = buffer.subarray(size + 4);
        const method = {initialize: () => ({clientId: 'fake-desktop'}), ...methods}[request.method];
        const result = await Promise.resolve(method?.(request.params)).catch(() => undefined);
        send({type: 'response', requestId: request.requestId, resultType: result === undefined ? 'error' : 'success', result});
      }
    });
  });
  await new Promise(resolve => server.listen(join(directory, 'ipc.sock'), resolve));
  return () => new Promise(resolve => server.close(resolve));
}

// changed() runs after each change. With `codexHome`, Desktop's IPC can start and stop the chat's turns.
export async function desktopChat(root, threadId, changed = () => {}, {codexHome} = {}) {
  const files = desktopFiles(root);
  const update = async change => { const history = await files.history(); change(history.turns); await files.writeHistory(history); await files.runQueue(threadId); changed(); };
  await usedChat(root);
  const live = async () => { const [turn] = (await files.history()).turns || []; return liveTurn(turn) ? turn : null; };
  const close = codexHome ? await serveDesktopIPC(codexHome, {
    async 'thread-follower-start-turn'({turnStart: {request}}) {
      const id = randomUUID();
      await update(turns => turns.unshift({id, status: 'inProgress', startedAt: now(), completedAt: null, items: [userMessage(request.input, request.clientUserMessageId)]}));
      return {result: {turn: {id}}};
    },
    // chill probes with a condition that never matches, then changes nothing.
    'thread-follower-update-thread-settings': ({condition}) => ({applied: false, condition}),
    async 'thread-follower-interrupt-turn'({expectedTurnId}) {
      if ((await live())?.id !== expectedTurnId) return {ok: true, interruptedTurnId: null};
      await update(([turn]) => Object.assign(turn, {status: 'interrupted', completedAt: now()}));
      return {ok: true, interruptedTurnId: expectedTurnId};
    },
  }) : async () => {};
  return {
    close,
    queue: files.queue,
    turns: async () => (await files.history()).turns || [],
    running: live,
    // The user types in Desktop; the turn starts at once.
    async startTurn() { const id = randomUUID(); await update(turns => turns.unshift({id, status: 'inProgress', startedAt: now(), completedAt: null, items: [userMessage([{type: 'text', text: 'Work', text_elements: []}])]})); return id; },
    endTurn: (status = 'completed') => update(([turn]) => Object.assign(turn, {status, completedAt: now()})),
    sent: () => sentTo(root, threadId),
  };
}
