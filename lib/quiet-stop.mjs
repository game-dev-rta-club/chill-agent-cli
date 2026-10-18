// When an agent stops, hold it once if feedback it took has gone quiet: the user
// has heard nothing about it since the agent last stopped, and nothing of the
// agent keeps running to wake it later. Every harness reports its stops here and
// carries the hold back in its own way (a Stop hook's block).
//
// Facts for one stop:
//   taken        [{eventId,goalId}]  feedback the agent took and has not completed
//   agentEvents  [{id,goalId}]       the agent's Comments and Letters
//   since        the largest change ID at the agent's last stop (0 before its first)
//   running      background work of the agent that goes on after this stop
//   held         whether the agent's last stop was held by this rule
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {agentKey,deliveryCarrier} from './agents/index.mjs';
import {listGoals,readFeedback,workspaceDirectory} from './goal-store.mjs';
import {readDeliveryState} from './delivery.mjs';
import {readJson,withStoreLock,writeJsonAtomically} from './storage.mjs';

// A Comment or Letter tells the user about feedback on its Goal only when it
// came after both the last stop and the feedback itself.
export function quietFeedback({taken,agentEvents,since,running,held}) {
  if(held||running>0)return [];
  return taken.filter(f=>!agentEvents.some(e=>e.goalId===f.goalId&&e.id>Math.max(since,f.eventId)));
}

function stopLocation(token) {
  const base=join(workspaceDirectory(),'agent-stops'),key=createHash('sha256').update(token).digest('hex').slice(0,24);
  return {record:join(base,`${key}.json`),lock:join(base,'locks',key)};
}

// `root` is any Root the stopping agent owns. `continues` says the harness
// already goes on with this stop for another reason, so it is not held again.
export async function agentStopped(root,{running=0,continues=false}={}) {
  const token=agentKey(root);
  if(!token)return [];
  const goals=await listGoals({includeArchived:true}),byId=new Map(goals.map(g=>[g.id,g]));
  const rootOf=id=>{let goal=byId.get(id);while(goal?.parentId)goal=byId.get(goal.parentId);return goal;};
  const events=await readFeedback(),taken=[];
  for(const event of events){
    if(event.author!=='user')continue;
    const owner=rootOf(event.goalId);
    if(!owner||agentKey(owner)!==token)continue;
    const state=await readDeliveryState(event.changeId);
    if(state&&deliveryCarrier(state)?.taken(state))taken.push({eventId:event.changeId,goalId:event.goalId});
  }
  const agentEvents=events.filter(e=>e.author==='agent'&&!e.deletedAt).map(({id,goalId})=>({id,goalId}));
  const cursor=events.reduce((max,e)=>Math.max(max,e.changeId),0),location=stopLocation(token);
  return withStoreLock(location.lock,async()=>{
    const last=await readJson(location.record)??{};
    const quiet=continues?[]:quietFeedback({taken,agentEvents,since:last.cursor??0,running,held:Boolean(last.held)});
    await writeJsonAtomically(location.record,{cursor,held:quiet.length>0});
    return quiet;
  });
}

// The hold's text; `reply` and `progress` are the harness's own commands.
export const quietStopReason=(quiet,{reply,progress})=>`chill-agent: before ending, tell the user where things stand. Nothing has reached them since you last stopped about feedback you took: ${quiet.map(f=>`#${f.eventId} (Goal #${f.goalId})`).join(', ')}, and nothing of yours keeps running to wake you.
If it is handled, reply (this completes it): ${reply}
If you wait for something (CI, a build, a review), post a progress comment on its Goal that says what you wait for and when you will check: ${progress}
Then end.`;
