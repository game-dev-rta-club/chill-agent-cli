export function executionState(goal, now = Date.now()) {
  const execution = goal.execution;
  return execution?.status === 'working' && !(Date.parse(execution.expiresAt) > now)
    ? 'unknown' : execution?.status;
}

// Activity takes display priority; only an explicit completion marks a Goal Done.
export function goalState(goal, childStates = [], now = Date.now()) {
  if (executionState(goal, now) === 'working' || childStates.includes('working')) return 'working';
  if (executionState(goal, now) === 'paused') return 'paused';
  if (!childStates.length) return goal.state;
  const unfinished=childStates.filter(state=>state!=='done');
  if (goal.state === 'waiting' || (unfinished.length && unfinished.every(state => state === 'waiting'))) return 'waiting';
  return goal.state;
}
