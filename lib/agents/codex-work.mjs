// What a Codex chat is doing and which of its Goals that work is for, by the
// shared rules (agent-rules) over the Codex app's own turns and the Roots'
// hand-off records. Comments reach the chat at its tool hooks and its Stop; an
// idle chat is sent them as its next message. While the chat works, chill
// holds them (Waiting).
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {dataDirectory,validThreadId,workspaceDirectory} from '../goal-store.mjs';
import {workspacePort} from '../project-workspace.mjs';
import {readJson,writeJsonAtomically} from '../storage.mjs';
import {withAgentControlLock} from '../agent-lock.mjs';
import {withCodex} from '../codex-client.mjs';
import {agentStatus} from '../agent-rules.mjs';
import {agentView,handRoots,ownedRoots,postFinalReply,quietStop} from '../hand-off.mjs';
import {agentPresence,observeAgentRun,invalidateAgentObservation} from './codex-observation.mjs';
import {readExecution} from './codex-execution.mjs';
import {workReader} from './codex-work-output.mjs';
import {feedbackText} from '../delivery.mjs';
import {stableNodePath} from '../node-path.mjs';
import {hidden,recordHidden} from '../hidden-failure.mjs';
import {resumeDesktopTurn} from '../desktop-settings.mjs';

// The chat's own record: the turn its handed Goals belong to (null: the next
// turn, which starts from a message chill sent), and whether the user paused it.
const recordPath=threadId=>join(workspaceDirectory(),'codex-work',`${validThreadId(threadId)}.json`);
const empty={turnId:null,goals:[],lastGoal:null,paused:false};
export const readCodexWork=async threadId=>({...empty,...await readJson(recordPath(threadId))});
const writeCodexWork=(threadId,record)=>writeJsonAtomically(recordPath(threadId),record);
// A hook names the turn it runs in. Goals handed in an earlier turn are not
// this turn's; ones handed for the next turn are.
const adopt=(record,turnId)=>record.turnId===turnId?record:record.turnId===null?{...record,turnId}:{...record,turnId,goals:[]};
const withHanded=(record,events)=>{const goals=[...new Set(events.map(e=>e.goalId))];return events.length?{...record,goals:[...new Set([...record.goals,...goals])],lastGoal:goals.at(-1)}:record;};
const owns=threadId=>goal=>goal.threadId===threadId;

// Everything shown for one chat, read once.
export async function codexSnapshot(threadId,{fresh=false}={}) {
  const [observed,record,selection]=await Promise.all([observeAgentRun(threadId,{fresh}).catch(hidden('codex-work.observe',null)),readCodexWork(threadId),readExecution(threadId)]);
  const presence=observed?agentPresence({...observed,selection}):'unknown',turn=observed?.turn??null;
  const phase=presence==='working'?'working':presence==='paused'?'interrupted':'idle';
  const work={phase,background:[],goals:phase==='working'&&[null,turn?.id].includes(record.turnId)?record.goals:[],lastGoal:record.lastGoal,id:turn?.id??null};
  const status=agentStatus({paused:record.paused,known:presence!=='unknown',work});
  const {goals,roots}=await ownedRoots(owns(threadId));
  const selected=status==='running'&&selection&&!selection.stoppedAt&&selection.turnId===turn?.id?selection.goalId:null;
  return {threadId,record,turn,reachable:Boolean(observed),...agentView({goals,roots,work,status,paused:record.paused,selected,queued:Boolean(observed?.queue?.data?.length)&&phase!=='working'})};
}

const quote=value=>`'${String(value).replaceAll("'","'\\''")}'`;
export const codexCommand=()=>`PORT=${quote(workspacePort())} CHILL_AGENT_DATA_DIR=${quote(dataDirectory())} ${quote(stableNodePath())} ${quote(fileURLToPath(new URL('../../bin/chill-agent.mjs',import.meta.url)))}`;
// The feedback text every harness shows (delivery feedbackText), with this chat's commands.
export const codexFeedbackText=(events,{limit}={})=>feedbackText(events,{cli:codexCommand(),reply:`${codexCommand()} comment --id <goalId> --text '<reply>'`,limit});

// A tool hook in the chat's turn: only what the user sent now is handed.
export async function codexToolHook({threadId,turnId,limit}) {
  validThreadId(threadId);validThreadId(turnId);
  return withAgentControlLock(threadId,async()=>{
    let record=adopt(await readCodexWork(threadId),turnId);
    const events=record.paused?[]:await handRoots((await ownedRoots(owns(threadId))).roots,{working:true});
    record=withHanded(record,events);
    await writeCodexWork(threadId,record);
    return events.length?codexFeedbackText(events,{limit}):null;
  });
}
// The chat's turn is ending: its final reply (`text`) answers a single Goal
// awaiting one (hand-off postFinalReply); what waited for the turn is handed
// and the turn goes on; otherwise the stop is held once for Goals still
// awaiting a reply. Codex lists no background work to its Stop hook, so none is counted.
export async function codexStop({threadId,turnId,text=null}) {
  validThreadId(threadId);
  return withAgentControlLock(threadId,async()=>{
    let record=turnId?adopt(await readCodexWork(threadId),turnId):await readCodexWork(threadId);
    await postFinalReply(owns(threadId),{text,key:['codex',threadId,record.turnId]});
    if(record.paused){await writeCodexWork(threadId,record);return null;}
    const {roots}=await ownedRoots(owns(threadId));
    const events=await handRoots(roots,{working:false});
    record=withHanded(record,events);
    await writeCodexWork(threadId,record);
    if(events.length)return {feedback:await codexFeedbackText(events)};
    const quiet=await quietStop(roots);
    return quiet.length?{quiet}:null;
  });
}
// Send what waits to a chat that is not working, as its next message. A chat
// that works receives it at its next hook; one Codex cannot reach keeps it
// saved. A chat whose state is unclear is sent it: at worst the message waits
// in the Codex app until the chat's turn ends.
export async function handIdleCodex(threadId) {
  return withAgentControlLock(threadId,async()=>{
    const snapshot=await codexSnapshot(threadId,{fresh:true});
    if(snapshot.record.paused||snapshot.work.phase==='working'||!snapshot.reachable)return [];
    let record=snapshot.record;
    const events=await handRoots(snapshot.roots,{working:false},async events=>sendMessage(snapshot,await codexFeedbackText(events)))
      .catch(error=>{recordHidden('codex-work.send',error);return [];});
    if(events.length){record=withHanded({...record,turnId:null,goals:[]},events);await writeCodexWork(threadId,record);invalidateAgentObservation(threadId);}
    return events;
  });
}
// Codex runs a queued message once the chat is idle, but not after its turn was
// stopped (Pause or Desktop's stop): then only Desktop starts the next turn.
async function sendMessage(snapshot,text) {
  const {threadId,turn}=snapshot,id=randomUUID();
  try{
    if(turn?.status==='interrupted'&&turn.completedAt!=null){
      const result=await resumeDesktopTurn(threadId,text,id);
      if(!result?.result?.turn?.id)throw Error('Codex did not start the turn.');
    }else{
      const result=await withCodex(client=>client.request('thread/queue/add',{threadId,clientUserMessageId:id,input:[{type:'text',text,text_elements:[]}]}));
      if(!result?.queuedSubmission?.id)throw Error('Codex did not accept the message.');
    }
  }catch(error){
    // A lost answer may follow an accepted message: never send it twice.
    if(!await accepted(threadId,id).catch(()=>false))throw error;
  }
}
// Codex queues an accepted message, or runs it at once.
const accepted=(threadId,id)=>withCodex(async client=>{
  const {data:turns}=await client.request('thread/turns/list',{threadId,limit:5});
  if(turns.some(turn=>turn.items.some(item=>item.type==='userMessage'&&item.clientId===id)))return true;
  let cursor;
  for(let page=0;page<20;page++){
    const result=await client.request('thread/queue/list',{threadId,limit:100,...(cursor?{cursor}:{})});
    if(result.data.some(entry=>entry.clientUserMessageId===id))return true;
    if(!(cursor=result.nextCursor))return false;
  }
  return false;
});
// Pause stops the running turn and holds comments; Resume sends what waits,
// or asks the chat to go on with the stopped work.
export async function pauseCodex(threadId,turnId,{interrupt}) {
  return withAgentControlLock(threadId,async()=>{
    const result=await interrupt(threadId,turnId);
    if(result?.ok!==true||result.interruptedTurnId!==turnId)throw Error('Pause unconfirmed. Refresh to check.');
    await writeCodexWork(threadId,{...await readCodexWork(threadId),paused:true});
    invalidateAgentObservation(threadId);
  });
}
export async function resumeCodex(threadId) {
  await withAgentControlLock(threadId,async()=>{
    const record=await readCodexWork(threadId);
    if(!record.paused)throw Error('Nothing to resume. Refresh to check.');
    await writeCodexWork(threadId,{...record,paused:false});
  });
  if((await handIdleCodex(threadId)).length)return;
  const goal=(await readCodexWork(threadId)).lastGoal;
  await sendMessage(await codexSnapshot(threadId,{fresh:true}),`The user selected Resume in the Web. ${goal?`Read the latest Goal #${goal}, then `:''}continue the stopped work. Do not repeat completed work.`);
  invalidateAgentObservation(threadId);
}

// The public text of the chat's current or last turn: Think.
export async function codexThink(snapshot) {
  const turnId=snapshot.work?.id||snapshot.record.turnId;
  if(!turnId)return null;
  const work=await withCodex(client=>workReader(client)({threadId:snapshot.threadId,turnId,history:[]}));
  return work&&{live:work.status==='working',settings:work.settings??null,startedAt:work.startedAt??null,messages:work.messages};
}
