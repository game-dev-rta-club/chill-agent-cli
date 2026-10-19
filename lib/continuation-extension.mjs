import {listGoals,readGoalContext,touch as hostTouch} from './extension-api.mjs';
import {agentContinuation,agentKey} from './agents/index.mjs';
import {MAX_CHECKS_PER_REVISION} from './continuation-monitor.mjs';

// An agent that continues at its own Stop rather than through the poller has
// no stale status between checks (live: false).
export function continuationActivity(state,now=Date.now(),{live=true}={}){
 const labels={running:'Agent running',queued:'Queue pending','feedback-pending':'Delivery pending',paused:'Paused',exhausted:'Checks complete',idle:'Watching',sending:'Sending','awaiting-receipt':'Awaiting confirmation',uncertain:'Delivery unconfirmed',unknown:'Status unavailable',changed:'Checking','assignment-changed':'Agent changed'};
 const activeCount=(state?.attempts||[]).filter(a=>!a.result&&!a.completedAt&&['sending','queued','running'].includes(a.phase)).length;
 const entries=[...(state?.history||[]),...(state?.attempts||[])].slice().reverse().slice(0,20).map(a=>({
  id:a.id,at:a.at,goalId:a.goalId||null,goalTitle:a.goalTitle||null,summary:a.summary||'Automatic check',
  logPath:`/activity/${a.id}`,
  status:a.result?'Result received':a.phase==='assignment-changed'?'Agent changed':a.completedAt?'Run ended':({sending:'Sending',queued:'Queued',running:'Last seen running',uncertain:'Delivery unconfirmed'}[a.phase]||'Status unavailable'),
  result:a.result?{label:a.result.outcome==='worked'?'Work reported':'No work reported',at:a.result.at}:null,
 }));
 const status=!state?.enabled?'Off':!live?(state.paused?'Paused':labels[state.status]||'Watching'):now-Date.parse(state.checkedAt)>90000||!state.checkedAt?'Checking':labels[state.status]||'Checking';
 return {label:'AutoContinue',status,checkedAt:state?.checkedAt||null,activeCount,runs:entries,total:(state?.history?.length||0)+(state?.attempts?.length||0)};
}

export function continuationKeepsAlive(f,state){
 // Active work is protected even when automatic nudges are disabled.
 if(f.queue.length||f.heartbeatFresh||f.harnessState==='active'||f.turn&&f.turn.completedAt==null)return true;
 if(f.pendingFeedback.length&&!f.paused)return true;
 if(!f.stable||!['idle','notLoaded','active'].includes(f.harnessState))return true;
 if(!state?.enabled||f.paused)return false;
 const last=state.attempts?.at(-1);
 if(last&&!last.completedAt&&!f.pendingWork?.endedAt)return true;
 return state.revision!==f.revision||(state.attempts?.length||0)<MAX_CHECKS_PER_REVISION;
}
// Each agent connection supplies its own AutoContinue:
// continuation = {live, read(), configure(enabled), runOutput(attempt), prepare?(), tick?(), busy?()}.
// Polled agents provide tick and busy; agents that continue themselves do not.
export function createContinuationExtension({roots=async()=>(await listGoals()).filter(g=>!g.parentId),context=readGoalContext,continuation=agentContinuation,token=agentKey,touch=hostTouch}={}){
 const ready=new Set();
 async function polled(){
  const list=[];
  for(const root of await roots()){const c=continuation(root);if(c?.tick)list.push([root,c]);}
  return list;
 }
 async function prepare(root,c){if(!ready.has(root.id)){await c.prepare?.();ready.add(root.id);}}
 return {
  id:'continuation',label:'Auto-continue',
  async start(){for(const [root,c] of await polled())await prepare(root,c);},
  async tick(){for(const [root,c] of await polled()){await prepare(root,c);await c.tick();}},
  async read(goalId,{activity=false}={}){
   const {root}=await context(goalId),c=continuation(root);
   if(!c)return null;
   const state=await c.read();
   return {rootId:root.id,enabled:Boolean(state?.enabled),placement:'header',icon:'repeat',...(activity?{activity:continuationActivity(state,Date.now(),{live:c.live})}:{})};
  },
  async request({method,path,query}){
   const match=/^activity\/([0-9a-f-]{36})$/i.exec(path);
   if(method!=='GET'||!match||!query.goalId)return {status:404,body:{error:'Not found.'}};
   const {root}=await context(query.goalId),c=continuation(root);
   const state=c&&await c.read();
   const attempt=state&&[...(state.history||[]),...(state.attempts||[])].find(a=>a.id===match[1]);
   if(!attempt)return {status:404,body:{error:'Activity not found.'}};
   const owner=token(root),{work,error}=await c.runOutput(attempt);
   if(token((await context(query.goalId)).root)!==owner)return {status:409,body:{error:'Agent changed. Refresh to retry.'}};
   return {status:200,body:{work,message:attempt.message||null,error}};
  },
  async set(goalId,input){
   const {root}=await context(goalId);if(input.rootId!==root.id)throw Error('Goal moved. Refresh to retry.');
   const c=continuation(root);if(!c)throw Error('No agent is connected to this Goal.');
   await prepare(root,c);await c.configure(input.enabled);await touch();
  },
  async busy(){
   for(const [,c] of await polled())if(c.busy&&await c.busy())return true;
   return false;
  },
 };
}

export const createExtension=createContinuationExtension;
