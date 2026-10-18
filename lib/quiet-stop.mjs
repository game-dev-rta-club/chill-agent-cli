// The text of the stop hold (agent-rules quietGoals): handed comments on these
// Goals still await a reply. `reply` and `progress` are the harness's own commands.
export const quietGoalsReason=(goals,{reply,progress})=>`chill-agent: before ending, tell the user where things stand. These Goals still wait for your reply to comments you were handed: ${goals.map(id=>`Goal #${id}`).join(', ')}, and nothing of yours keeps running to wake you.
If it is handled, reply on the Goal: ${reply}
If you wait for something (CI, a build, a review), post a progress comment on its Goal that says what you wait for and when you will check: ${progress}
Then end.`;
