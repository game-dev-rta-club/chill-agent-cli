import {listGoals,readGoalContext,observe as continuationObservation,touch as hostTouch,readRunOutput} from './extension-api.mjs';
import {configureMonitor,readMonitor,tickMonitor,MAX_CHECKS_PER_REVISION} from './continuation-monitor.mjs';
import {monitorService} from './continuation-service.mjs';
import {readForWeb as readClaude,configureFromWeb as configureClaude} from './claude-continuation.mjs';

// Claude continues at its own Stop rather than through this poller, so its
// status is not stale between checks (live: false).
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
const claudeRoot=root=>!root.threadId&&root.connection?.harnessId==='claude-code';
export function createContinuationExtension({roots=async()=>(await listGoals()).filter(g=>!g.parentId&&g.threadId),context=readGoalContext,read=readMonitor,configure=configureMonitor,tick=tickMonitor,observe=continuationObservation,output=readRunOutput,retireLegacy=async id=>{if(process.platform==='darwin')await monitorService(id,'stop');},touch=hostTouch,claude={read:readClaude,configure:configureClaude}}={}){
 const ready=new Set();
 async function prepare(root){if(!ready.has(root.id)){await retireLegacy(root.id);ready.add(root.id);}}
 return {
  id:'continuation',label:'Auto-continue',
  async start(){for(const root of await roots())await prepare(root);},
  async tick(){for(const root of await roots()){await prepare(root);await tick(root.id);}},
  async read(goalId,{activity=false}={}){
   const {root}=await context(goalId);
   // A Claude Root is continued by its own conversation's Stop hook; Web only
   // switches it, with the same control as Codex.
   if(claudeRoot(root)){const state=await claude.read(root.id);return {rootId:root.id,enabled:Boolean(state?.enabled),placement:'header',icon:'repeat',...(activity?{activity:continuationActivity(state,Date.now(),{live:false})}:{})};}
   if(!root.threadId)return null;const stored=await read(root.id);const state=stored?.threadId===root.threadId?stored:null;return {rootId:root.id,enabled:Boolean(state?.enabled),placement:'header',icon:'repeat',...(activity?{activity:continuationActivity(state)}:{})};
  },
  async request({method,path,query}){
   const match=/^activity\/([0-9a-f-]{36})$/i.exec(path);
   if(method!=='GET'||!match||!query.goalId)return {status:404,body:{error:'Not found.'}};
   const {root}=await context(query.goalId);
   if(claudeRoot(root)){
    // Claude's output stays in its own conversation; the saved request is shown.
    const state=await claude.read(root.id),attempt=[...(state?.history||[]),...(state?.attempts||[])].find(a=>a.id===match[1]);
    return attempt?{status:200,body:{work:null,message:attempt.message||null,error:null}}:{status:404,body:{error:'Activity not found.'}};
   }
   const state=await read(root.id);
   if(!state||state.threadId!==root.threadId)return {status:404,body:{error:'Activity not found.'}};
   const attempt=[...(state.history||[]),...(state.attempts||[])].find(a=>a.id===match[1]);
   if(!attempt)return {status:404,body:{error:'Activity not found.'}};
   let work=attempt.work||null,error=null;
   if(!work?.endedAt){
    try{work=await output({threadId:state.threadId,id:attempt.id,at:attempt.at,turnId:attempt.turnId,
      matchText:`chill monitor result --id ${root.id} --attempt ${attempt.id} --outcome worked`})||work;}
    catch{error='Updates unavailable. Saved output is kept.';}
   }
   if((await context(query.goalId)).root.threadId!==state.threadId)return {status:409,body:{error:'Agent changed. Refresh to retry.'}};
   return {status:200,body:{work,message:attempt.message||null,error}};
  },
  async set(goalId,input){const {root}=await context(goalId);if(input.rootId!==root.id)throw Error('Goal moved. Refresh to retry.');if(claudeRoot(root))await claude.configure(root.id,input.enabled);else{await prepare(root);await configure(root.id,input.enabled);}await touch();},
  async busy(){
   for(const root of await roots()){
    const state=await read(root.id);
    // A failed observation is not proof that work has stopped.
    try{if(continuationKeepsAlive(await observe(root.id,state?.attempts?.at(-1)),state))return true;}catch{return true;}
   }
   return false;
  },
 };
}

export const createExtension=createContinuationExtension;
