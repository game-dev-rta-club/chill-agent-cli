import {readTurnSettings} from './codex-turn-settings.mjs';
import {hidden} from '../hidden-failure.mjs';
// The public output of one Codex turn, found by its ID or, for an end-of-turn
// run, by the ID its request was queued with. `history` gives the time the
// request was saved, below which no turn is searched.
export function workReader(client) {
  const turns = new Map(), items = new Map(), paths = new Map();
  async function settings(threadId,turnId){
    if(!paths.has(threadId))paths.set(threadId,client.request('thread/read',{threadId,includeTurns:false}).then(r=>r.thread?.path).catch(hidden('work-output.thread-path')));
    return readTurnSettings(await paths.get(threadId),turnId);
  }
  async function findTurn(state) {
    const matches = turn => turn.id === state.turnId || state.messageId && turn.items?.some(item => item.type === 'userMessage' && item.clientId === state.messageId);
    if (!turns.has(state.threadId)) turns.set(state.threadId, {data: [], cursor: null, done: false});
    const cache = turns.get(state.threadId);
    while (!cache.data.some(matches) && !cache.done) {
      const response = await client.request('thread/turns/list', {threadId: state.threadId, limit: 25, itemsView: 'full', ...(cache.cursor ? {cursor: cache.cursor} : {})});
      cache.data.push(...response.data);
      if (response.nextCursor && response.nextCursor === cache.cursor) throw new Error('Turn history cursor did not advance.');
      cache.cursor = response.nextCursor;
      cache.done = !cache.cursor;
      // Turns older than the request cannot contain it.
      const savedAt = Date.parse(state.history?.find(item => item.status === 'saved')?.at);
      const oldest = response.data.at(-1)?.startedAt;
      if (!state.turnId && Number.isFinite(savedAt) && Number.isFinite(oldest) && oldest * 1000 < savedAt - 2000) break;
    }
    return cache.data.find(matches);
  }
  async function readItems(threadId, turnId) {
    const key = `${threadId}:${turnId}`;
    if (!items.has(key)) items.set(key, (async () => {
      const result = [], seen = new Set();
      let cursor;
      do {
        const response = await client.request('thread/items/list', {threadId, turnId, limit: 100, sortDirection: 'desc', ...(cursor ? {cursor} : {})});
        result.push(...response.data);
        cursor = response.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error('Item history cursor did not advance.');
        if (cursor) seen.add(cursor);
      } while (cursor);
      return result;
    })());
    return items.get(key);
  }
  return async state => {
    const turn = await findTurn(state);
    if (!turn) return null; // Still queued, or history hasn't been persisted yet.
    const snapshot = await readItems(state.threadId, turn.id);
    const unique = new Map();
    for (const entry of snapshot.slice().reverse()) {
      const item = entry.item;
      if (entry.turnId !== turn.id || item?.type !== 'agentMessage' || typeof item.text !== 'string' || !item.text.trim()) continue;
      // Only user-facing text; never reasoning or tool input/output. Missing
      // timestamps must not discard otherwise valid public text.
      const old = unique.get(item.id);
      if (!old || old.text.length < item.text.trim().length) unique.set(item.id, {
        id: item.id, text: item.text.trim(), at: entry.startedAtMs ?? null,
      });
    }
    // Another app-server can report interrupted during a live Desktop turn.
    // A persisted completion timestamp is required before we close Progress.
    const endedAt = Number.isFinite(turn.completedAt) ? new Date(turn.completedAt * 1000).toISOString() : null;
    const status = endedAt ? (turn.status === 'failed' || turn.status === 'interrupted' ? turn.status : 'completed') : 'working';
    return {source: 'turn', turnId: turn.id, status, settings:await settings(state.threadId,turn.id),
      startedAt: Number.isFinite(turn.startedAt) ? new Date(turn.startedAt * 1000).toISOString() : null,
      endedAt, messages: [...unique.values()].sort((a,b) => (a.at ?? 0)-(b.at ?? 0)), truncated: false};
  };
}
