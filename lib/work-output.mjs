import {readTurnSettings} from './turn-settings.mjs';
// Public output belongs to the Codex turn, not to the interval between the
// agent's activity receipts. Read before/after those receipts automatically.
export function workReader(client) {
  const turns = new Map(), items = new Map(), paths = new Map();
  async function settings(threadId,turnId){
    if(!paths.has(threadId))paths.set(threadId,client.request('thread/read',{threadId,includeTurns:false}).then(r=>r.thread?.path).catch(()=>null));
    return readTurnSettings(await paths.get(threadId),turnId);
  }
  async function findTurn(state) {
    const known = state.batchTurnId || state.hookTurnId || state.turnId || state.work?.turnId;
    const marker = `[chill-agent:${state.batchId || state.messageId}]`;
    const matches = turn => turn.items?.some(item => item.type === 'userMessage' &&
      item.content?.some(part => part.type === 'text' && (part.text.includes(marker) ||
        (state.matchText && part.text.split('\n').some(line => line.trim() === state.matchText)))));
    if (!turns.has(state.threadId)) turns.set(state.threadId, {data: [], cursor: null, done: false});
    const cache = turns.get(state.threadId);
    const match = () => cache.data.find(turn => state.batchTurnId ? turn.id === state.batchTurnId : matches(turn) || turn.id === known);
    // A Queue fallback may arrive in a newer turn than an unclaimed hook.
    // Find it before the old hook turn, including when output is already cached.
    while (!match() && !cache.done) {
      const response = await client.request('thread/turns/list', {threadId: state.threadId, limit: 25, itemsView: 'full', ...(cache.cursor ? {cursor: cache.cursor} : {})});
      cache.data.push(...response.data);
      if (response.nextCursor && response.nextCursor === cache.cursor) throw new Error('Turn history cursor did not advance.');
      cache.cursor = response.nextCursor;
      cache.done = !cache.cursor;
      // With no known turn, older turns cannot contain this queued notice.
      const savedAt = Date.parse(state.history.find(item => item.status === 'saved')?.at);
      const oldest = response.data.at(-1)?.startedAt;
      if (!known && Number.isFinite(savedAt) && Number.isFinite(oldest) && oldest * 1000 < savedAt - 2000) break;
    }
    return match();
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

export function needsWorkRefresh(state) {
  if (!state?.threadId || state.heldBy) return false;
  // Migrate existing interval snapshots, including the first display tests.
  if (state.work && (state.work.source !== 'turn'||!Object.hasOwn(state.work,'settings'))) return true;
  if (state.workError || state.work?.status === 'working') return true;
  if (state.work?.endedAt && state.agentReported) return false;
  if (state.workTracking && !state.work?.endedAt) return true;
  return ['queued', 'received', 'working', 'unknown'].includes(state.reportedStatus ?? state.status) || Boolean(state.hookTurnId && !state.agentReported);
}

// The Web reflects persisted Codex execution. Activity receipts still own
// feedback acknowledgement/queue cleanup and remain available as reportedStatus.
export function presentDelivery(state) {
  if(state?.heldBy)return {...state,reportedStatus:state.status,status:'paused'};
  if (state?.work?.source !== 'turn') {
    // An acknowledgement alone does not identify a running execution.
    return state?.status==='working'&&!state.turnId&&!state.hookTurnId&&!state.batchTurnId
      ? {...state,reportedStatus:state.status,status:'received'} : state;
  }
  const {status} = state.work;
  return {...state, reportedStatus: state.status,
    status: status === 'interrupted' ? 'failed' : status,
    ...(status === 'interrupted' ? {error: 'Codex stopped before finishing this turn.'} :
      status === 'failed' ? {error: 'Codex reported a problem.'} : {})};
}
