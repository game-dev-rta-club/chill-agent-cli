// Agent menu data and controls for a Goal. Harness-neutral: everything comes
// through the Root's agent connection (lib/agents).
import {readGoalContext,listGoals,readFeedback} from './goal-store.mjs';
import {agentFor,agentKey} from './agents/index.mjs';

async function current(goalId){
  const {goal,root}=await readGoalContext(goalId);
  return {goal,root,agent:agentFor(root)};
}
// A request made against one connection must not act on a reassigned Root.
async function assertToken(goalId,token){
  const {agent}=await current(goalId);
  if(!agent||(token!==undefined&&token!==agent.token))throw Error('Agent changed. Refresh to retry.');
  return agent;
}

export async function readAgentStatus(goalId) {
  const {goal,root,agent}=await current(goalId);
  const result={goalId:goal.id,rootId:root.id,rootTitle:root.title,connected:Boolean(agent),capabilities:{settings:false,stop:false,resume:false,approveAll:false}};
  if(!agent)return result;
  const [status,recent]=await Promise.all([agent.status(goalId),recentGoals(agent)]);
  if((await current(goalId)).agent?.token!==agent.token)throw Error('Agent assignment changed. Try again.');
  return {...result,...status,recent,token:agent.token};
}
// The Goals this agent's Roots were most recently active in, newest first and
// each once, so moving between several Goals keeps them one click away.
async function recentGoals(agent,limit=5){
  const goals=await listGoals(),byId=new Map(goals.map(g=>[g.id,g]));
  const rootOf=g=>{while(g?.parentId)g=byId.get(g.parentId);return g;};
  const owned=new Set(goals.filter(g=>!g.parentId&&agentKey(g)===agent.token).map(g=>g.id));
  const events=await readFeedback(),seen=new Set(),recent=[];
  for(let i=events.length-1;i>=0&&recent.length<limit;i--){
    const goal=byId.get(events[i].goalId);
    if(!goal||seen.has(goal.id)||!owned.has(rootOf(goal)?.id))continue;
    seen.add(goal.id);recent.push({goalId:goal.id,title:goal.title,at:events[i].updatedAt||events[i].createdAt||null});
  }
  return recent;
}

export async function saveAgentSettings(goalId,input){
  const agent=await assertToken(goalId,input.token);
  await agent.saveSettings(goalId,input);
  return readAgentStatus(goalId);
}

export async function controlAgent(goalId,input){
  if(input.scope==='permissions'){
    const agent=await assertToken(goalId,input.token);
    if(!(await readAgentStatus(goalId)).capabilities.approveAll)throw Error('Approve all is not available for this agent.');
    await agent.setApproveAll(input.approveAll);
    return readAgentStatus(goalId);
  }
  if(!['stop','resume'].includes(input.action))throw Error('Status changed. Refresh to check.');
  if(input.scope==='current'){
    const agent=await assertToken(goalId,input.token);
    if(!(await readAgentStatus(goalId)).capabilities[input.action])throw Error('Status changed. Refresh to check.');
    await agent.control(goalId,input);
    return readAgentStatus(goalId);
  }
  // Activity controls act on the run that received one delivered message.
  const agent=await assertToken(goalId,input.token);
  const activity=await agent.controlActivity(goalId,input);
  return activity&&{...activity,token:agent.token};
}

// The Activity row control under one message: the run that received it.
export async function readAgentActivityRow(goalId){
  const {agent}=await current(goalId);
  if(!agent)return null;
  const activity=await agent.activity(goalId);
  if((await current(goalId)).agent?.token!==agent.token)throw Error('Agent assignment changed. Try again.');
  return activity&&{...activity,token:agent.token};
}
