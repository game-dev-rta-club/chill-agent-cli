// Several feedback entries can be handled in one Codex turn. Show their
// shared public output once, attached to the last related entry on this page.
export function workProgressGroups(events, deliveries, activity=null) {
  const groups = new Map();
  for (const event of events) {
    if (event.author !== 'user') continue;
    const saved = deliveries.get(event.changeId);
    const current = activity?.eventId===event.changeId ? activity : null;
    const previous=current?.turnId===saved?.work?.turnId?saved?.work:null;
    const state = current?.turnId ? {...saved,threadId:current.threadId,status:current.status,
      work:{...previous,...current.work,turnId:current.turnId,messages:[...previous?.messages||[],...current.work?.messages||[]]}} : saved;
    if (!state || !state.work && !state.workError && state.status !== 'working') continue;
    const turnId=state.work?.turnId || state.batchTurnId || state.hookTurnId || state.turnId;
    const key = `${event.goalId}:${state.threadId}:${turnId || `event-${event.changeId}`}`;
    if (!groups.has(key)) groups.set(key, {key,threadId:state.threadId,turnId, eventIds: [], live: false, messages: new Map(), error: false, truncated: false});
    const group = groups.get(key);
    group.eventIds.push(event.changeId);
    group.owner = event.changeId;
    if(activity&&activity.turnId===turnId&&activity.threadId===state.threadId&&activity.goalId===event.goalId)group.activity=activity;
    group.live ||= state.status === 'working';
    group.error ||= Boolean(state.workError);
    group.truncated ||= Boolean(state.work?.truncated);
    for (const message of state.work?.messages || []) {
      const old = group.messages.get(message.id);
      if (!old || old.text.length < message.text.length) group.messages.set(message.id, message);
    }
  }
  return new Map([...groups.values()].map(group => {
    const superseded=activity?.turnId&&activity.threadId===group.threadId&&group.turnId&&activity.turnId!==group.turnId;
    const live=group.activity?group.activity.status==='working':superseded?false:group.live;
    return [group.owner,{...group,live,status:superseded&&group.live?'ended':group.activity?.status,
      messages:[...group.messages.values()].sort((a,b)=>a.at-b.at)}];
  }));
}

export function workDisclosure(previous, live) {
  return !previous || previous.live !== live ? {live, open: live} : previous;
}
