// One driver per agent harness, so a user-visible flow is written once (test/harness-scenarios.test.mjs)
// and runs against the fake Codex and against a Claude Code conversation.
//
// A driver plays the agent and reads what the user sees. start(t) returns a session:
//   goalId                          the Root Goal the agent is assigned to
//   agentStartsResponse()           the agent begins a response (a Codex turn, a Claude response)
//   agentEndsResponse()             that response ends
//   agentTakesFeedback(eventId)     the agent's next opportunity to read Web feedback, then its `activity working`
//                                   receipt. An idle agent is woken by the feedback, which starts its response.
//                                   Resolves to the feedback IDs that reached it.
//   agentReports(eventId, state)    `activity --state <state>` (working, completed, failed)
//   agentDefers(eventId)            `activity deferred`: {deferred:true}, or {unsupported:message}
//   strangerReports(eventId)        a conversation the Goal is not assigned to reports `completed` for the feedback
//   agentReplies(eventId, text)     the reply that completes the feedback
//   agentSelectsWork()              `goal work` on the Root Goal for the current response
//   saveFeedback(text)              the user posts feedback in the Web; resolves to its event ID
//   sendNow(eventId)                the user's Send now
//   retry(eventId)                  the user's Retry or Check on a delivery
//   shown(eventId)                  the state label under the feedback (Waiting, Received, Running, Done, ...)
//   activityRow()                   the Activity row under the latest message
//   goalRunning()                   whether the Goal list marks the Goal Running
//   agentStatus()                   the Agent menu data
//   pauseRow(action)                the Activity row's Pause ('stop') or Resume
//   approveAll(on)                  the Agent menu's Approve all
//   receipt(eventId)                the status the agent reported for the feedback, apart from what the Web shows of it
//   comments()                      the agent's comments on the Goal
// A capability the harness lacks is declared in `capabilities` and the scenario asserts the interface says so.
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {appendFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {appendFeedback,createGoal,listGoals,readFeedback} from '../lib/goal-store.mjs';
import {deliverFeedback,sendFeedbackNow} from '../lib/delivery.mjs';
import {agentExecutions,assignGoal,deliveriesWithWork,selectAgentWork} from '../lib/agents/index.mjs';
import {controlAgent,readAgentActivityRow,readAgentStatus} from '../lib/agent-status.mjs';
import {invalidateAgentObservation} from '../lib/agents/codex-observation.mjs';
import {captureClaudeEntry} from '../lib/claude-entry.mjs';
import {executionState,isRunning} from '../public/goal-state.js';
import {deliveryDisplay,workProgressGroups} from '../public/work-ui.js';
import {claudeEntry,claudeLine,hookFor} from './claude-fixtures.mjs';

// Codex's reads of a chat are cached for a few seconds. Moving this process's clock past them stands for time passing,
// so a read after the response ended is not answered from the read made while it ran.
const realNow=Date.now;
let skew=0;
Date.now=()=>realNow()+skew;
const passTime=()=>{skew+=6000;};
const bin=name=>fileURLToPath(new URL(`../bin/${name}`,import.meta.url));
const cli=bin('chill-agent.mjs'),connectionCli=bin('chill-connection.mjs'),codexHook=bin('chill-hook.mjs');
const fakeCodex=fileURLToPath(new URL('./fake-codex.mjs',import.meta.url));

async function runWith(file,args,{env,cwd,input}={}) {
  const child=spawn(process.execPath,[file,...args],{env,cwd,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
  child.stdin.end(input===undefined?'':JSON.stringify(input));
  return new Promise((resolve,reject)=>{
    child.on('error',reject);
    child.on('close',code=>code===0?resolve(stdout):reject(Object.assign(new Error(stderr.trim()||`exit ${code}`),{stdout,stderr,code})));
  });
}

// The harness-neutral half: what the user does in the Web and what the Web then shows.
function userSide(goalId,beforeRead=()=>{}) {
  return {
    goalId,
    async saveFeedback(text) {
      const event=await appendFeedback({goalId,text});
      await deliverFeedback(event.changeId);
      return event.changeId;
    },
    sendNow:eventId=>sendFeedbackNow(eventId),
    retry:eventId=>deliverFeedback(eventId),
    // The same derivation the page runs (public/work-ui.js), from the data the page fetches.
    async shown(eventId) {
      beforeRead();
      const deliveries=new Map((await deliveriesWithWork(goalId)).map(delivery=>[delivery.eventId,delivery]));
      const events=(await readFeedback()).filter(event=>event.goalId===goalId);
      const row=await readAgentActivityRow(goalId);
      const work=workProgressGroups(events,deliveries,row).get(eventId);
      const activity=work?.activity||(row?.eventId===eventId?row:null);
      return deliveryDisplay({delivery:deliveries.get(eventId),work,activity}).state;
    },
    async activityRow() {beforeRead();return readAgentActivityRow(goalId);},
    async goalRunning() {
      beforeRead();
      const execution=(await agentExecutions(await listGoals())).get(goalId);
      return isRunning(executionState({execution}));
    },
    async agentStatus() {beforeRead();return readAgentStatus(goalId);},
    // The Pause or Resume button of the Activity row.
    async pauseRow(action) {
      const row=await readAgentActivityRow(goalId);
      return controlAgent(goalId,{action,token:row?.token,eventId:row?.eventId,threadId:row?.threadId,turnId:row?.turnId});
    },
    async approveAll(on) {
      const {token}=await readAgentStatus(goalId);
      return controlAgent(goalId,{scope:'permissions',token,approveAll:on});
    },
    // What the agent reported, apart from what the Web shows of it.
    async receipt(eventId) {
      const delivery=(await deliveriesWithWork(goalId)).find(item=>item.eventId===eventId);
      return delivery.reportedStatus??delivery.status;
    },
    async comments() {
      return (await readFeedback()).filter(event=>event.goalId===goalId&&event.author==='agent').map(event=>event.text);
    },
  };
}

// Each test gets its own data directory; the process-wide variables the libraries read are restored afterwards.
async function workspace(t,prefix,env) {
  const dir=await mkdtemp(join(tmpdir(),prefix)),previous={};
  for(const [key,value] of Object.entries({CHILL_AGENT_DATA_DIR:join(dir,'data'),...env})) {
    previous[key]=process.env[key];process.env[key]=value;
  }
  t.after(async()=>{
    for(const [key,value] of Object.entries(previous))value===undefined?delete process.env[key]:process.env[key]=value;
    await rm(dir,{recursive:true,force:true});
  });
  return dir;
}

// ---- Codex ----------------------------------------------------------------------

const codexFeedbackIds=text=>[...new Set([...text.matchAll(/^Feedback: #(\d+)$/gm),...text.matchAll(/feedback #(\d+)/g)].map(match=>Number(match[1])))];

async function codexSession(t) {
  const dir=await workspace(t,'chill-scenario-codex-',{CHILL_AGENT_CODEX_PATH:fakeCodex});
  const data=process.env.CHILL_AGENT_DATA_DIR,thread=randomUUID();
  await mkdir(data,{recursive:true});
  passTime();
  const env={...process.env,CODEX_THREAD_ID:thread},turns=[];
  const writeHistory=async status=>{
    await writeFile(join(data,'fake-history.json'),JSON.stringify({status,turns:turns.slice().reverse()}));
    invalidateAgentObservation(thread);
  };
  const running=()=>turns.at(-1)?.completedAt===null?turns.at(-1):null;
  const startTurn=async items=>{
    turns.push({id:randomUUID(),status:'inProgress',completedAt:null,items});
    await writeHistory({type:'active',activeFlags:[]});
  };
  const queue=async()=>JSON.parse(await readFile(join(data,'fake-queue.json'),'utf8').catch(()=>'[]'));
  const root=await createGoal({title:'A useful outcome'});
  await assignGoal(root.id,thread);
  await writeHistory({type:'idle'});
  const session={
    ...userSide(root.id,()=>invalidateAgentObservation(thread)),
    async agentStartsResponse() {await startTurn([]);},
    async agentEndsResponse() {
      Object.assign(turns.at(-1),{status:'completed',completedAt:Math.floor(Date.now()/1000)});
      await writeHistory({type:'idle'});
      passTime();
    },
    async agentTakesFeedback(eventId) {
      let ids;
      if(running()) {
        const output=await runWith(codexHook,[],{env,input:{hook_event_name:'PostToolUse',session_id:thread,turn_id:running().id}});
        ids=output?codexFeedbackIds(JSON.parse(output).hookSpecificOutput.additionalContext):[];
      } else {
        // The chat's native Queue starts its next turn from the queued message.
        const entries=await queue(),entry=entries.find(item=>codexFeedbackIds(item.input[0].text).includes(eventId));
        if(!entry)return [];
        await writeFile(join(data,'fake-queue.json'),JSON.stringify(entries.filter(item=>item!==entry)));
        await startTurn([{type:'userMessage',id:randomUUID(),content:entry.input}]);
        ids=codexFeedbackIds(entry.input[0].text);
      }
      if(ids.includes(eventId))await runWith(cli,['activity','--event',String(eventId),'--state','working'],{env});
      return ids;
    },
    agentReports:(eventId,state)=>runWith(cli,['activity','--event',String(eventId),'--state',state],{env}),
    async agentDefers(eventId) {
      try {
        await this.agentReports(eventId,'deferred');
        return {deferred:true};
      } catch(error) {return {unsupported:error.message};}
    },
    strangerReports:eventId=>runWith(cli,['activity','--event',String(eventId),'--state','completed'],{env:{...env,CODEX_THREAD_ID:randomUUID()}}),
    async agentReplies(eventId,text) {
      await runWith(cli,['comment','--id',root.id,'--text',text],{env});
      await runWith(cli,['activity','--event',String(eventId),'--state','completed'],{env});
    },
    agentSelectsWork:()=>selectAgentWork(root.id,{env}),
  };
  return session;
}

// ---- Claude Code ----------------------------------------------------------------

const claudeOffers=text=>[...text.matchAll(/"eventId":(\d+),"offerId":"([0-9a-f-]{36})"/g)].map(match=>({eventId:Number(match[1]),offerId:match[2]}));

async function claudeSession(t) {
  const dir=await workspace(t,'chill-scenario-claude-',{CHILL_AGENT_CODEX_PATH:'/never/call/codex'});
  const cwd=join(dir,'project'),transcript=join(dir,'session.jsonl'),sessionId=randomUUID(),envFile=join(dir,'claude-env');
  await mkdir(cwd);await writeFile(envFile,'');await writeFile(transcript,'');
  const event=hookFor({session_id:sessionId,cwd,transcript_path:transcript});
  await captureClaudeEntry(event('SessionStart',{source:'startup'}),{cwd,env:{CLAUDE_ENV_FILE:envFile}});
  const agentEnv={CHILL_AGENT_HARNESS:'claude-code',CHILL_AGENT_SESSION_ID:sessionId,CLAUDE_CODE_SESSION_ID:sessionId};
  const env={...process.env,...agentEnv};
  const hook=async(name,patch)=>{
    const output=await runWith(connectionCli,['claude-hook'],{env,cwd,input:event(name,patch)});
    return output.trim()?JSON.parse(output):null;
  };
  const connection=args=>runWith(connectionCli,args,{env,cwd});
  const append=entries=>appendFile(transcript,entries.map(claudeLine).join(''));
  await connection(['create-goal','--title','A useful outcome']);
  const [root]=await listGoals();
  let responding=false,handoff=null;
  const startResponse=async()=>{
    await append([claudeEntry.prompt(randomUUID(),'Do the work')]);
    await hook('UserPromptSubmit',{prompt:'Do the work'});
    responding=true;
  };
  const session={
    ...userSide(root.id),
    agentStartsResponse:startResponse,
    async agentEndsResponse() {
      // The Stop hook hands over feedback that waited for the end; the response then goes on with it.
      const output=await hook('Stop');
      if(output?.decision==='block'){handoff=output.reason;return;}
      await append([claudeEntry.text(randomUUID(),'Finished.'),claudeEntry.stop({uuid:randomUUID()})]);
      responding=false;
    },
    async agentTakesFeedback(eventId) {
      let text;
      if(responding) {
        text=handoff??(await hook('PostToolUse'))?.hookSpecificOutput?.additionalContext??'';handoff=null;
        // Claude Code records what a hook injects into the conversation.
        await append(claudeOffers(text).map(({eventId,offerId})=>claudeEntry.offer(eventId,offerId)));
      } else {
        // A waiter wakes the idle conversation, which reads its inbox.
        await startResponse();
        text=await connection(['inbox']);
        const call=randomUUID();
        await append([claudeEntry.tool(randomUUID(),'Bash',{command:'connection inbox'},undefined,call),claudeEntry.toolResult(randomUUID(),call,text)]);
      }
      const ids=claudeOffers(text).map(offer=>offer.eventId);
      if(ids.includes(eventId))await runWith(cli,['activity','--event',String(eventId),'--state','working'],{env});
      return ids;
    },
    agentReports:(eventId,state)=>runWith(cli,['activity','--event',String(eventId),'--state',state],{env}),
    async agentDefers(eventId) {
      try {
        await this.agentReports(eventId,'deferred');
        return {deferred:true};
      } catch(error) {return {unsupported:error.message};}
    },
    // Another conversation in the same project.
    async strangerReports(eventId) {
      const other=randomUUID();
      await captureClaudeEntry(hookFor({session_id:other,cwd,transcript_path:transcript})('SessionStart',{source:'startup'}),{cwd,env:{CLAUDE_ENV_FILE:join(dir,'other-env')}});
      await runWith(cli,['activity','--event',String(eventId),'--state','completed'],{env:{...env,CHILL_AGENT_SESSION_ID:other,CLAUDE_CODE_SESSION_ID:other}});
    },
    async agentReplies(eventId,text) {await connection(['reply','--event',String(eventId),'--text',text]);},
    agentSelectsWork:()=>selectAgentWork(root.id,{env:agentEnv}),
  };
  return session;
}

const win32Codex=process.platform==='win32'&&'Codex Desktop harness is macOS-only; fake-codex.mjs runs as an executable';

export const drivers=[
  {name:'Codex',skip:win32Codex,start:codexSession,agentName:'Codex',pending:'queued',
    // Approve all and settings are Claude features; pausing a Codex chat needs the running Desktop app.
    capabilities:{deferredReceipts:true,approveAll:false,pause:false},
    todo:{'a failed receipt asks for attention':'A finished turn shows as Done over the agent\'s failed receipt, which only reaches reportedStatus (presentDelivery in lib/delivery.mjs)'}},
  {name:'Claude Code',start:claudeSession,agentName:'Claude Code',pending:'saved',
    capabilities:{deferredReceipts:false,approveAll:true,pause:true}},
];
