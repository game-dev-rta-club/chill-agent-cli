// Conversation is still one chronological stream. This state only controls
// which older messages are shown; it is independent of Brief history.
import {letterState} from './letter-state.js';
export const INITIAL_COMMENT_COUNT = 3;
export const EXPANSION_COMMENT_COUNT = 3;

const protectedIds=(messages,pinned)=>new Set([...pinned,
  ...messages.filter(message=>letterState(message,messages)?.status==='open').map(message=>message.id)]);

export function createConversationWindow() {
  const goals = new Map();
  function state(id, messages) {
    if (!goals.has(id)) {
      goals.set(id, {shown: new Set(messages.slice(-INITIAL_COMMENT_COUNT).map(e => e.id)), known: new Set(messages.map(e => e.id))});
    }
    const value = goals.get(id);
    for (const message of messages) {
      // New arrivals stay visible without making the reader's current place vanish.
      if (!value.known.has(message.id)) value.shown.add(message.id);
      value.known.add(message.id);
    }
    return value;
  }
  function segments(id, messages, pinned = new Set()) {
    const {shown} = state(id, messages), protectedMessages=protectedIds(messages,pinned), result = [];
    for (const message of messages) {
      const kind = shown.has(message.id) || protectedMessages.has(message.id) ? 'messages' : 'gap';
      if (result.at(-1)?.kind !== kind) result.push({kind, messages: []});
      result.at(-1).messages.push(message);
    }
    return result;
  }
  return {
    segments,
    expand(id, messages, firstId, lastId, side) {
      const first = messages.findIndex(e => e.id === firstId), last = messages.findIndex(e => e.id === lastId);
      if (first < 0 || last < first) return [];
      const added = side === 'top' ? messages.slice(first, Math.min(first + EXPANSION_COMMENT_COUNT, last + 1))
        : messages.slice(Math.max(first, last - EXPANSION_COMMENT_COUNT + 1), last + 1);
      const {shown} = state(id, messages);
      added.forEach(e => shown.add(e.id));
      return added;
    },
    reveal(id, messages, eventId) { state(id, messages).shown.add(eventId); },
    collapse(id, messages) { state(id, messages).shown = new Set(messages.slice(-INITIAL_COMMENT_COUNT).map(e => e.id)); },
    canCollapse(id, messages, pinned = new Set()) {
      const {shown} = state(id, messages), protectedMessages=protectedIds(messages,pinned);
      return messages.slice(0, -INITIAL_COMMENT_COUNT).some(e => shown.has(e.id) && !protectedMessages.has(e.id));
    },
  };
}
