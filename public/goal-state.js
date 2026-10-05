// Running is a display group. Keep queue/control facts separate for operations.
export const isRunning = status => ['working', 'queued', 'checking'].includes(status);

export function executionState(goal, now = Date.now()) {
  const execution = goal.execution;
  return isRunning(execution?.status) && !(Date.parse(execution.expiresAt) > now)
    ? 'unknown' : execution?.status;
}

// Activity takes display priority; only an explicit completion marks a Goal Done.
export function goalState(goal, childStates = [], now = Date.now()) {
  if (isRunning(executionState(goal, now)) || childStates.includes('working')) return 'working';
  if (executionState(goal, now) === 'paused') return 'paused';
  if (!childStates.length) return goal.state;
  const unfinished=childStates.filter(state=>state!=='done');
  if (goal.state === 'waiting' || (unfinished.length && unfinished.every(state => state === 'waiting'))) return 'waiting';
  return goal.state;
}
