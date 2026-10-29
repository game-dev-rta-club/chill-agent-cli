// What a Goal page shows for its agent and under its comments, from the
// server's views (lib/hand-off.mjs goalActivity and commentMarks).

// The small mark under a comment that still awaits a reply. A comment the
// Goal has a reply after shows none.
const markLabels = {saved: 'Saved', waiting: 'Waiting', paused: 'Paused', handed: 'Sent', interrupted: 'Interrupted'};
const markDescriptions = {
  waiting: 'Arrives when the current work ends.',
  paused: 'Arrives when you resume the agent.',
  interrupted: 'The agent was stopped in its own app.',
};
export function commentMarkDisplay(view) {
  if (!view?.mark) return null;
  const description = view.unassigned ? 'No chat is assigned to this Goal.' : view.sendNow ? 'Arrives at the agent’s next step.' : markDescriptions[view.mark] || '';
  return {state: view.mark, label: markLabels[view.mark] || 'Saved', description, sendNow: view.mark === 'waiting'};
}

// The agent as the Goal shows it after its conversation, with Think: the
// public text of its current or last work there.
const activityLabels = {running: 'Running', queued: 'Queued', paused: 'Paused', interrupted: 'Interrupted', idle: 'Ended', unknown: 'Status unavailable'};
const activityDescriptions = {
  queued: 'Waiting to start in the agent’s app.',
  paused: 'Comments wait until you resume.',
  interrupted: 'Stopped in the agent’s own app. It runs again with its next work.',
  unknown: 'Could not read the agent.',
};
// What the agent waits on once its own work has ended: the subagents it left
// running, and the checks it scheduled (agent wake), earliest first. Each
// shows one line; a check's full reason folds under it.
const overdueMs = 5 * 60 * 1000;
export const isWaitingOnCheck = (wake, now = Date.now()) => Boolean(wake) && now - Date.parse(wake.at) <= overdueMs;
const clockTime = at => new Date(Date.parse(at)).toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit'});
// The first sentence or line of a reason, which the agent writes for itself.
export const firstLine = text => String(text || '').trim().split(/\n|(?<=。)|(?<=\.)\s/)[0].trim();
// The list itself, shared by the Goal page and the Agent menu.
const escapeText = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
export const waitListMarkup = items => items.length ? `<ul class="wait-list">${items.map(item => `<li${item.overdue ? ' data-overdue' : ''}><span class="wait-kind">${escapeText(item.kind)}</span><span class="wait-text">${escapeText(item.text)}</span><span class="wait-when">${escapeText(item.when)}</span>${item.detail ? `<details class="wait-detail"><summary>Details</summary><p>${escapeText(item.detail)}</p></details>` : ''}</li>`).join('')}</ul>` : '';
export function waitItems(activity, now = Date.now()) {
  const ago = at => { const ms = now - Date.parse(at); return ms < 60000 ? 'just now' : `${Math.round(ms / 60000)} min ago`; };
  const kind = type => /agent/i.test(type || '') ? 'Subagent' : type ? type[0].toUpperCase() + type.slice(1) : 'Task';
  const tasks = (activity?.background || []).map(task => ({kind: kind(task.type), text: task.description || task.name || task.type || 'Background task',
    when: task.since ? `since ${clockTime(task.since)}` : task.activeAt ? `active ${ago(task.activeAt)}` : ''}));
  const wakes = (activity?.wakes || (activity?.wake ? [activity.wake] : [])).map(wake => {
    const line = firstLine(wake.reason), overdue = !isWaitingOnCheck(wake, now);
    return {kind: 'Check', text: line || 'No reason given', when: `${overdue ? 'was due' : 'at'} ${clockTime(wake.at)}`, detail: wake.reason && wake.reason.trim() !== line ? wake.reason.trim() : '', overdue};
  });
  return [...tasks, ...wakes];
}
function waitingDisplay(activity, now) {
  const items = waitItems(activity, now);
  // Only checks, and the earliest long past its time: nothing is left to wake the agent.
  if (!activity.background?.length && items[0]?.overdue) return {state: 'unknown', label: 'Check overdue', description: 'The check was due, and nothing has woken the agent.', items, live: false};
  return {state: 'waiting', label: items.length > 1 ? `Waiting · ${items.length}` : 'Waiting', description: '', items, live: false};
}
export function activityDisplay(activity, now = Date.now()) {
  // Its own work ended and it waits on checks or on subagents it left running.
  if (activity?.status === 'idle' && activity.wake || activity?.status === 'running' && activity.background?.length) return waitingDisplay(activity, now);
  if (!activity || activity.status === 'idle' && !activity.work?.messages?.length) return null;
  return {state: activity.status, label: activityLabels[activity.status] || activityLabels.unknown, description: activityDescriptions[activity.status] || '',
    live: activity.status === 'running' && activity.work?.live !== false};
}

// Think opens while its work runs and closes when it ends, unless the user
// opened or closed it meanwhile.
export function workDisclosure(previous, live) {
  return !previous || previous.live !== live ? {live, open: live} : previous;
}

// Think shows only the newest message, held at three lines so its height does
// not change as messages arrive, and folds the older ones into one row. The
// user can open them all, as before, and fold them again.
export function thinkView(messages, all = false) {
  const list = messages || [];
  if (all || list.length < 2) return {earlier: 0, shown: list, clamped: !all && list.length === 1, less: all && list.length > 0};
  return {earlier: list.length - 1, shown: list.slice(-1), clamped: true, less: false};
}
