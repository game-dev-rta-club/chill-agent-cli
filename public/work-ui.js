// Several feedback entries can be handled in one Codex turn. Show their
// shared public output once, attached to the last related entry on this page.
export function workProgressGroups(events, deliveries) {
  const groups = new Map();
  for (const event of events) {
    if (event.author !== 'user') continue;
    const state = deliveries.get(event.changeId);
    if (!state || !state.work && !state.workError && state.status !== 'working') continue;
    const key = `${event.goalId}:${state.threadId}:${state.work?.turnId || state.hookTurnId || `event-${event.changeId}`}`;
    if (!groups.has(key)) groups.set(key, {key, eventIds: [], live: false, messages: new Map(), error: false, truncated: false});
    const group = groups.get(key);
    group.eventIds.push(event.changeId);
    group.owner = event.changeId;
    group.live ||= state.status === 'working';
    group.error ||= Boolean(state.workError);
    group.truncated ||= Boolean(state.work?.truncated);
    for (const message of state.work?.messages || []) {
      const old = group.messages.get(message.id);
      if (!old || old.text.length < message.text.length) group.messages.set(message.id, message);
    }
  }
  return new Map([...groups.values()].map(group => [group.owner, {...group, messages: [...group.messages.values()].sort((a,b)=>a.at-b.at)}]));
}

export function workDisclosure(previous, live) {
  return !previous || previous.live !== live ? {live, open: live} : previous;
}
