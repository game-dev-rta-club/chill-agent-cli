// User answers and Agent receipt are explicit; ordinary comments leave Letters alone.
export function letterState(letter, conversation = []) {
  if (letter?.type !== 'letter' || letter.author !== 'agent') return null;
  const answer = conversation.findLast(entry => entry.goalId === letter.goalId && entry.author === 'user'
    && entry.annotations?.some(note => note.kind === 'letter' && note.source?.kind === 'comment' && note.source.eventId === letter.id));
  return {status: letter.receivedAt ? 'received' : answer ? 'answered' : 'open', lastAnswerId: answer?.id || null};
}
