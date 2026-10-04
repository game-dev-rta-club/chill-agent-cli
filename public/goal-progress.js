// Count completed leaf Goals equally, independently of Brief and Conversation.
export function ownGoalProgress(goal) {
  return goal.state==='done'?1:0;
}

export function progressPercent(scores, goal) {
  const percent=scores.length?Math.round(scores.reduce((sum,score)=>sum+score,0)/scores.length*100):0;
  // Open is capped for clarity. Done never replaces the measured percentage.
  return goal.state==='done'?percent:Math.min(percent,99);
}
