import {goalReferences} from './markdown.mjs';

const parsed = new Map();
function references(text) {
  if (!parsed.has(text)) {
    if (parsed.size >= 4096) parsed.delete(parsed.keys().next().value);
    parsed.set(text, goalReferences(text));
  }
  return parsed.get(text);
}
// Like a GitHub cross-reference: each other visible Goal that names a Goal
// appears once on it, at the Comment that named it first.
export function goalMentions(events, visible) {
  const mentions = new Map();
  for (const event of [...events].sort((a, b) => a.id - b.id)) {
    if (event.deletedAt || !event.text?.includes('#') || !visible.has(event.goalId)) continue;
    for (const target of references(event.text)) {
      const list = mentions.get(target) || [];
      if (target === event.goalId || list.some(m => m.goalId === event.goalId)) continue;
      list.push({goalId:event.goalId, eventId:event.id, at:event.updatedAt});
      mentions.set(target, list);
    }
  }
  return mentions;
}
