// One driver per agent harness, so a user-visible flow is written once (test/harness-scenarios.test.mjs)
// and runs against the fake Codex and against a Claude Code conversation.
//
// A driver plays the agent and reads what the user sees. start(t) returns a session:
//   goalId                          the Root Goal the agent is assigned to
//   agentStartsResponse()           the agent begins a response (a Codex turn, a Claude response)
//   agentEndsResponse({background}) that response ends. Resolves to the reason when chill holds the stop, and the
//                                   response then goes on; else null. `background`: work of the agent keeps running.
//   agentIsInterrupted()            the user stops the running response in the agent's own app (Esc, Desktop's stop)
//   agentTakesFeedback(eventId)     the agent's next opportunity to read Web feedback. An idle agent is woken by the
//                                   feedback, which starts its response. Resolves to the feedback IDs that reached it.
//   strangerAnswers(eventId)        a conversation the Goal is not assigned to tries to answer the feedback
//   agentReplies(eventId, text)     the agent's reply on the feedback's Goal
//   agentSelectsWork()              `goal work` on the Root Goal for the current response
//   agentComments(text)             a progress `goal comment` on the Root Goal
//   saveFeedback(text)              the user posts feedback in the Web; resolves to its event ID
//   sendNow(eventId)                the user's Send now
//   shown(eventId)                  the small mark under the feedback (saved, waiting, paused, handed, interrupted),
//                                   or null once the Goal has a reply after it
//   activity()                      the agent as the Goal shows it after its conversation: {state,label,live,work}|null
//   goalRunning()                   whether the Goal list marks the Goal Running
//   agentStatus()                   the Agent menu data
//   pauseActivity(action)           the Goal activity's Pause ('stop') or Resume
//   approveAll(on)                  the Agent menu's Approve all
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
import {agentExecutions,assignGoal,goalCommentMarks,selectAgentWork} from '../lib/agents/index.mjs';
import {controlAgent,readGoalActivity,readAgentStatus} from '../lib/agent-status.mjs';
import {invalidateAgentObservation} from '../lib/agents/codex-observation.mjs';
import {captureClaudeEntry} from '../lib/claude-entry.mjs';
import {claimClaudeFeedbackForWatcher} from '../lib/claude-actions.mjs';
import {executionState,isRunning} from '../public/goal-state.js';
import {activityDisplay,commentMarkDisplay} from '../public/work-ui.js';
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
    // What the page shows, from the data it fetches (public/work-ui.js).
    async shown(eventId) {
      beforeRead();
      return commentMarkDisplay((await goalCommentMarks(goalId)).find(view=>view.eventId===eventId))?.state??null;
    },
    async activity() {
      beforeRead();
      const activity=await readGoalActivity(goalId),shown=activityDisplay(activity);
      return shown&&{...shown,work:activity.work,capabilities:activity.capabilities};
    },
    async goalRunning() {
      beforeRead();
      const execution=(await agentExecutions(await listGoals())).get(goalId);
      return isRunning(executionState({execution}));
    },
    async agentStatus() {beforeRead();return readAgentStatus(goalId);},
    // The Pause or Resume button of the Goal's activity.
    async pauseActivity(action) {
      const activity=await readGoalActivity(goalId);
      return controlAgent(goalId,{action,token:activity?.token,turnId:activity?.turnId});
    },
    async approveAll(on) {
      const {token}=await readAgentStatus(goalId);
      return controlAgent(goalId,{scope:'permissions',token,approveAll:on});
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

const feedbackIds=text=>[...text.matchAll(/"eventId":(\d+),"goalId"/g)].map(match=>Number(match[1]));

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
  let continuing=false,handoff=null;
  const root=await createGoal({title:'A useful outcome'});
  await assignGoal(root.id,thread);
  await writeHistory({type:'idle'});
  const session={
    ...userSide(root.id,()=>invalidateAgentObservation(thread)),
    async agentStartsResponse() {await startTurn([]);},
    // Codex runs the Stop hook as the turn ends; a block continues the turn with the reason.
    async agentEndsResponse() {
      const output=await runWith(codexHook,[],{env,input:{hook_event_name:'Stop',session_id:thread,turn_id:turns.at(-1)?.id??randomUUID(),stop_hook_active:continuing,
        last_assistant_message:'Done.',cwd:dir,model:'gpt-5.5',permission_mode:'default',transcript_path:null}});
      const hold=output.trim()?JSON.parse(output):null;
      continuing=hold?.decision==='block';
      if(continuing){handoff=hold.reason;return hold.reason;}
      Object.assign(turns.at(-1),{status:'completed',completedAt:Math.floor(Date.now()/1000)});
      await writeHistory({type:'idle'});
      passTime();
      return null;
    },
    async agentIsInterrupted() {
      Object.assign(turns.at(-1),{status:'interrupted',completedAt:Math.floor(Date.now()/1000)});
      await writeHistory({type:'idle'});
      continuing=false;handoff=null;passTime();
    },
    async agentTakesFeedback(eventId) {
      let ids;
      if(running()) {
        const output=await runWith(codexHook,[],{env,input:{hook_event_name:'PostToolUse',session_id:thread,turn_id:running().id}});
        ids=handoff?feedbackIds(handoff):output?feedbackIds(JSON.parse(output).hookSpecificOutput.additionalContext):[];
        handoff=null;
      } else {
        // The chat starts its next turn from the message chill sent it.
        const entries=await queue(),entry=entries.find(item=>feedbackIds(item.input[0].text).includes(eventId));
        if(!entry)return [];
        await writeFile(join(data,'fake-queue.json'),JSON.stringify(entries.filter(item=>item!==entry)));
        await startTurn([{type:'userMessage',id:randomUUID(),content:entry.input}]);
        ids=feedbackIds(entry.input[0].text);
      }
      return ids;
    },
    // Another chat in the same project replies on the Goal.
    strangerAnswers:()=>runWith(cli,['comment','--id',root.id,'--text','Not mine'],{env:{...env,CODEX_THREAD_ID:randomUUID()}}),
    agentReplies:(eventId,text)=>runWith(cli,['comment','--id',root.id,'--text',text],{env}),
    agentComments:text=>runWith(cli,['comment','--id',root.id,'--text',text],{env}),
    agentSelectsWork:()=>selectAgentWork(root.id,{env}),
  };
  return session;
}

// ---- Claude Code ----------------------------------------------------------------


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
  let responding=false,handoff=null,continuing=false;
  const startResponse=async()=>{
    await append([claudeEntry.prompt(randomUUID(),'Do the work')]);
    await hook('UserPromptSubmit',{prompt:'Do the work'});
    responding=true;
  };
  const session={
    ...userSide(root.id),
    agentStartsResponse:startResponse,
    async agentEndsResponse({background=false}={}) {
      // A blocked Stop hands over feedback that waited for the end, or holds the stop; the response then goes on.
      const output=await hook('Stop',{stop_hook_active:continuing,background_tasks:background?[{id:'a1b2c3',type:'subagent',status:'running',description:'Review the change',agent_type:'general-purpose'}]:[]});
      continuing=output?.decision==='block';
      if(continuing){handoff=output.reason;return output.reason;}
      await append([claudeEntry.text(randomUUID(),'Finished.'),claudeEntry.stop({uuid:randomUUID()})]);
      responding=false;handoff=null;
      return null;
    },
    async agentIsInterrupted() {
      // Claude Code stamps the transcript with the real clock, which passTime does not move.
      await append([claudeEntry.interrupt(randomUUID(),{timestamp:new Date().toISOString()})]);
      responding=false;handoff=null;continuing=false;
    },
    // No receipt follows: what reached it is handed, and its Goal awaits a reply.
    async agentTakesFeedback() {
      let text;
      if(responding) {text=handoff??(await hook('PostToolUse'))?.hookSpecificOutput?.additionalContext??'';handoff=null;}
      else {
        // The watcher hook wakes the idle conversation with the feedback, which starts its work.
        text=await claimClaudeFeedbackForWatcher(sessionId);
        if(text){await append([claudeEntry.prompt(randomUUID(),'chill-agent watcher')]);responding=true;}
      }
      return feedbackIds(text);
    },
    // Another conversation in the same project replies on the Goal.
    async strangerAnswers() {
      const other=randomUUID();
      await captureClaudeEntry(hookFor({session_id:other,cwd,transcript_path:transcript})('SessionStart',{source:'startup'}),{cwd,env:{CLAUDE_ENV_FILE:join(dir,'other-env')}});
      await runWith(connectionCli,['reply','--goal',root.id,'--text','Not mine'],{env:{...env,CHILL_AGENT_SESSION_ID:other,CLAUDE_CODE_SESSION_ID:other},cwd});
    },
    async agentReplies(eventId,text) {await connection(['reply','--goal',root.id,'--text',text]);},
    agentComments:text=>runWith(cli,['comment','--id',root.id,'--text',text],{env}),
    agentSelectsWork:()=>selectAgentWork(root.id,{env:agentEnv}),
  };
  return session;
}

const win32Codex=process.platform==='win32'&&'Codex Desktop harness is macOS-only; fake-codex.mjs runs as an executable';

export const drivers=[
  {name:'Codex',skip:win32Codex,start:codexSession,agentName:'Codex',pending:'handed',
    // Approve all and settings are Claude features; pausing a Codex chat needs the running Desktop app.
    // Codex's Stop hook input names no background work, so chill cannot see it.
    capabilities:{approveAll:false,pause:false,backgroundWork:false}},
  {name:'Claude Code',start:claudeSession,agentName:'Claude Code',pending:'saved',
    capabilities:{approveAll:true,pause:true,backgroundWork:true}},
];
