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
// A check the agent scheduled turns Ended into Waiting; one long past its time
// means nothing is left to wake the agent.
const overdueMs = 5 * 60 * 1000;
function waitingDisplay({at, reason}, now) {
  const due = Date.parse(at), time = new Date(due).toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit'});
  if (now - due > overdueMs) return {state: 'unknown', label: 'Check overdue', description: `${reason ? `${reason}. ` : ''}The check was due at ${time}.`, live: false};
  return {state: 'waiting', label: 'Waiting', description: `${reason ? `${reason}. ` : ''}Checks again at ${time}.`, live: false};
}
export function activityDisplay(activity, now = Date.now()) {
  if (activity?.status === 'idle' && activity.wake) return waitingDisplay(activity.wake, now);
  if (!activity || activity.status === 'idle' && !activity.work?.messages?.length) return null;
  return {state: activity.status, label: activityLabels[activity.status] || activityLabels.unknown, description: activityDescriptions[activity.status] || '',
    live: activity.status === 'running' && activity.work?.live !== false};
}

// Think opens while its work runs and closes when it ends, unless the user
// opened or closed it meanwhile.
export function workDisclosure(previous, live) {
  return !previous || previous.live !== live ? {live, open: live} : previous;
}
