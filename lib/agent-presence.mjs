import {readGoalContext,listGoals} from './goal-store.mjs';
import {readControlRecord,controlView} from './agent-control.mjs';
import {readExecution,heartbeatTTL} from './goal-execution.mjs';
import {readFeedbackHold} from './feedback-hold.mjs';
import {withCodex} from './codex-client.mjs';

// Presence is chat-wide and independent of feedback receipts or monitor policy.
export function agentPresence({turn,view,threadState,selection,holds=[]},now=Date.now()){
 if(view)return view.status;
 if(threadState==='active')return 'working';
 if(!['idle','notLoaded'].includes(threadState))return 'unknown';
 if(turn&&turn.completedAt==null){
  if(threadState==='idle')return 'unknown';
  if(turn.status==='inProgress'||selection&&!selection.stoppedAt&&selection.turnId===turn.id&&now-Date.parse(selection.heartbeatAt)<heartbeatTTL)return 'working';
  return 'unknown';
 }
 if(holds.some(h=>h?.phase==='paused')||turn?.status==='interrupted')return 'paused';
 if(holds.some(h=>h&&['holding','dispatching','uncertain'].includes(h.phase)))return 'unknown';
 if(turn?.completedAt!=null&&['completed','failed'].includes(turn.status)||threadState==='idle')return 'idle';
 return 'unknown';
}
// Read native state and the latest turn through one connection to avoid startup
// duplication and disagreeing snapshots from two independently opened clients.
export async function readPresenceSnapshot(threadId,{connect=withCodex,readControl=readControlRecord}={}){
 const [record,native]=await Promise.all([readControl(threadId),connect(async client=>{
  const [response,turns]=await Promise.all([client.request('thread/read',{threadId,includeTurns:false}),client.request('thread/turns/list',{threadId,limit:1,itemsView:'notLoaded'})]);
  return {threadState:response.thread?.status?.type,turn:turns.data?.[0]||null};
 })]);
 return {...native,view:controlView(record,native.turn)};
}
const snapshots=new Map();
async function observe(threadId){
 const cached=snapshots.get(threadId);if(cached&&(cached.pending||Date.now()-cached.at<1000))return cached.promise;
 const promise=(async()=>{
  const [activity,selection,goals]=await Promise.all([readPresenceSnapshot(threadId),readExecution(threadId),listGoals()]);
  const holds=(await Promise.all(goals.map(g=>readFeedbackHold(g.id)))).filter(h=>h?.threadId===threadId);
  const status=agentPresence({...activity,selection,holds});
  const selected=status==='working'&&selection&&!selection.stoppedAt&&selection.turnId===activity.turn?.id;
  const target=goals.find(g=>g.id===(selected?selection.goalId:activity.view?.goalId));
  return {status,goalId:target?.id||null,title:target?.title||null,checkedAt:new Date().toISOString()};
 })();
 const snapshot={at:Date.now(),promise,pending:true};snapshots.set(threadId,snapshot);if(snapshots.size>40)snapshots.delete(snapshots.keys().next().value);
 try{return await promise;}catch(error){snapshots.delete(threadId);throw error;}finally{snapshot.pending=false;snapshot.at=Date.now();}
}
export async function readAgentPresence(goalId){
 const {root}=await readGoalContext(goalId);
 if(!root.threadId)return {connected:false,status:'unlinked'};
 const result=await observe(root.threadId);
 if((await readGoalContext(goalId)).root.threadId!==root.threadId)throw Error('Agent assignment changed.');
 return {connected:true,...result};
}
