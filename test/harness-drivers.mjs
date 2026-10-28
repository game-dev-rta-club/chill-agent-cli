// One driver per agent harness, so a user-visible flow is written once (test/harness-scenarios.test.mjs)
// and runs against the fake Codex and against a Claude Code conversation. With CHILL_SCENARIO_CODEX set, it runs
// against the installed Codex app-server instead (scripts/probe-codex.mjs scenarios).
//
// A driver plays the agent and reads what the user sees. start(t) returns a session:
//   goalId                          the Root Goal the agent is assigned to
//   agentStartsResponse()           the agent begins a response (a Codex turn, a Claude response)
//   agentEndsResponse({background}) that response ends. Resolves to the reason when chill holds the stop, and the
//                                   response then goes on; else null. `background`: work of the agent keeps running.
//   userRunsLocalCommand()          the user runs a command of the agent's own app, such as /reload-skills: it writes to
//                                   the conversation but starts no work
//   agentIsInterrupted()            the user stops the running response in the agent's own app (Esc, Desktop's stop)
//   agentTakesFeedback(eventId)     the agent's next opportunity to read Web feedback. An idle agent is woken by the
//                                   feedback, which starts its response. Resolves to the feedback IDs that reached it.
//   strangerAnswers(eventId)        a conversation the Goal is not assigned to tries to answer the feedback
//   agentReplies(eventId, text)     the agent's reply on the feedback's Goal
//   agentAsks(ask, text)            the agent's reply marked --ask: a Letter titled `ask`, with or without feedback
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
//   setAutonomy(level)              the Autonomy control in the Goal's comment box (its Root agent's level)
//   feedbackText()                  the last feedback text that reached the agent
//   permissionPrompt()              a tool permission prompt in the agent's app: 'allow' when chill answers it, else
//                                   null. Only where a hook can answer prompts (capabilities.approvals)
//   comments()                      the agent's comments on the Goal
//   letters()                       the titles of the Goal's open Letters, as the Letters menu lists them
// A capability the harness lacks is declared in `capabilities` and the scenario asserts the interface says so.
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {appendFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {appendFeedback,createGoal,listGoals,readFeedback,readOpenLetters} from '../lib/goal-store.mjs';
import {setRootAutonomy} from '../lib/root-autonomy.mjs';
import {deliverFeedback,sendFeedbackNow} from '../lib/delivery.mjs';
import {agentExecutions,assignGoal,goalCommentMarks,selectAgentWork} from '../lib/agents/index.mjs';
import {controlAgent,readGoalActivity,readAgentStatus} from '../lib/agent-status.mjs';
import {invalidateAgentObservation} from '../lib/agents/codex-observation.mjs';
import {captureClaudeEntry} from '../lib/claude-entry.mjs';
import {claimClaudeFeedbackForWatcher} from '../lib/claude-actions.mjs';
import {executionState,isRunning} from '../public/goal-state.js';
import {activityDisplay,commentMarkDisplay} from '../public/work-ui.js';
import {claudeEntry,claudeLine,hookFor} from './claude-fixtures.mjs';
import {desktopChat,serveDesktopIPC} from './fake-codex-desktop.mjs';
import {allowHidden} from './hidden-failures.mjs';

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
    setAutonomy:level=>setRootAutonomy(goalId,level),
    feedbackText:()=>lastFeedback,
    async comments() {
      return (await readFeedback()).filter(event=>event.goalId===goalId&&event.author==='agent').map(event=>event.text);
    },
    async letters() {return (await readOpenLetters(goalId)).map(letter=>letter.title);},
  };
}

// Each test gets its own data directory; the process-wide variables the libraries read are restored afterwards.
async function workspace(t,prefix,env) {
  // Each test starts from the real clock: Codex hooks stamp their heartbeat with it, and skew piled up over
  // earlier tests would make a fresh heartbeat look stale.
  skew=0;lastFeedback='';
  const dir=await mkdtemp(join(tmpdir(),prefix)),previous={};
  for(const [key,value] of Object.entries({CHILL_AGENT_DATA_DIR:join(dir,'data'),...env})) {
    previous[key]=process.env[key];process.env[key]=value;
  }
  t.after(async()=>{
    for(const [key,value] of Object.entries(previous))value===undefined?delete process.env[key]:process.env[key]=value;
    await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  return dir;
}

// ---- Codex ----------------------------------------------------------------------

// The IDs in a text that reached the agent; the last feedback text is kept for scenarios that read it.
let lastFeedback='';
const feedbackIds=text=>{if(text?.includes('=== chill-agent · User Feedback ==='))lastFeedback=text;return [...(text||'').matchAll(/"eventId":(\d+),"goalId"/g)].map(match=>Number(match[1]));};

async function codexSession(t) {
  const dir=await workspace(t,'chill-scenario-codex-',{CHILL_AGENT_CODEX_PATH:fakeCodex});
  const data=process.env.CHILL_AGENT_DATA_DIR,thread=randomUUID();
  await mkdir(data,{recursive:true});
  passTime();
  const env={...process.env,CODEX_THREAD_ID:thread};
  // Desktop runs the chat; chill sees it from a second process, as the real one (test/fake-codex-desktop.mjs).
  const chat=await desktopChat(data,thread,()=>invalidateAgentObservation(thread),{codexHome:process.env.CODEX_HOME});
  t.after(chat.close);
  const hook=async(name,turnId,extra={})=>{const output=await runWith(codexHook,[],{env,input:{hook_event_name:name,session_id:thread,turn_id:turnId,...extra}});return output.trim()?JSON.parse(output):null;};
  // A tool call in the running turn: Codex runs PostToolUse, which is how chill learns the turn works.
  const tool=async()=>{const output=await hook('PostToolUse',(await chat.running()).id);if(output)handoff.push(...feedbackIds(output.hookSpecificOutput.additionalContext));};
  let continuing=false,handoff=[];
  const read=new Set();
  const root=await createGoal({title:'A useful outcome'});
  await assignGoal(root.id,thread);
  const session={
    ...userSide(root.id,()=>invalidateAgentObservation(thread)),
    async agentStartsResponse() {await chat.startTurn();await tool();},
    // Codex runs the Stop hook as the turn ends; a block continues the turn with the reason.
    async agentEndsResponse() {
      const turn=await chat.running();
      const hold=await hook('Stop',turn?.id??randomUUID(),{stop_hook_active:continuing,last_assistant_message:'Done.',cwd:dir,model:'gpt-5.5',permission_mode:'default',transcript_path:null});
      continuing=hold?.decision==='block';
      if(continuing){handoff.push(...feedbackIds(hold.reason));return hold.reason;}
      if(turn)await chat.endTurn('completed');
      passTime();
      return null;
    },
    // Codex's own commands start no turn.
    async userRunsLocalCommand() {},
    async agentIsInterrupted() {
      await chat.endTurn('interrupted');
      continuing=false;handoff=[];passTime();
    },
    async agentTakesFeedback() {
      const turn=await chat.running();
      if(!turn)return [];
      // A turn Codex started from a message chill sent: the model reads it, then calls its first tool.
      const message=turn.items[0]?.clientId&&!read.has(turn.id)?turn.items[0].content[0].text:null;
      if(message){read.add(turn.id);handoff.push(...feedbackIds(message));}
      await tool();
      const ids=handoff;handoff=[];
      return ids;
    },
    // Another chat in the same project replies on the Goal.
    strangerAnswers:()=>runWith(cli,['comment','--id',root.id,'--text','Not mine'],{env:{...env,CODEX_THREAD_ID:randomUUID()}}),
    agentReplies:(eventId,text)=>runWith(cli,['comment','--id',root.id,'--text',text],{env}),
    agentAsks:(ask,text)=>runWith(cli,['comment','--id',root.id,'--ask',ask,'--text',text],{env}),
    agentComments:text=>runWith(cli,['comment','--id',root.id,'--text',text],{env}),
    agentSelectsWork:()=>selectAgentWork(root.id,{env}),
  };
  return session;
}

// ---- Codex app-server -------------------------------------------------------------
// The real Codex app-server stands in for Desktop and runs chill's real hooks; only the model is scripted, so nothing
// is billed. Opt-in through CHILL_SCENARIO_CODEX (the Codex path), as scripts/probe-codex.mjs scenarios sets it.

const textOf=value=>typeof value==='string'?value:Array.isArray(value)?value.map(textOf).join('\n'):value&&typeof value==='object'?Object.values(value).map(textOf).join('\n'):'';

async function codexAppSession(t,codexPath) {
  const kit=await import('../scripts/probe-codex-kit.mjs');
  allowHidden(t,'codex-desktop-connection.snapshot-usage');// usage needs a Codex login, which this run never uses
  const requests=[];
  const model=await kit.fakeModel(request=>new Promise(resolve=>requests.push({request,resolve})));
  const home=await mkdtemp(join(tmpdir(),'chill-scenario-codex-home-')),project=await mkdtemp(join(tmpdir(),'chill-scenario-codex-project-'));
  await writeFile(join(home,'config.toml'),model.config);
  await workspace(t,'chill-scenario-codex-app-',{CHILL_AGENT_CODEX_PATH:codexPath,CODEX_HOME:home,HOME:home,FAKE_KEY:'x'});
  await mkdir(process.env.CHILL_AGENT_DATA_DIR,{recursive:true});
  const A=new kit.AppServer(codexPath,home,'desktop',{FAKE_KEY:'x'});
  let closeIPC=async()=>{};
  t.after(async()=>{await closeIPC();await A.stop();await model.close();for(const dir of [home,project])await rm(dir,{recursive:true,force:true,maxRetries:5});});
  const call=async(method,params)=>{const reply=await A.call(method,params);if(!reply.result)throw Error(`${method}: ${reply.error?.message??'timeout'}`);return reply.result;};
  await A.init();
  // chill's hooks, trusted as a user trusts them in Desktop.
  await (await import('../bin/chill-hook.mjs')).installHook(project);
  await call('config/value/write',{keyPath:`projects."${project}".trust_level`,value:'trusted',mergeStrategy:'upsert'});
  for(const hook of (await call('hooks/list',{cwds:[project]})).data[0].hooks)
    await call('config/value/write',{keyPath:`hooks.state."${hook.key}".trusted_hash`,value:hook.currentHash,mergeStrategy:'upsert'});
  const until=async(done,what,timeout=20000)=>{const end=Date.now()+timeout;while(Date.now()<end){const value=done();if(value)return value;await kit.sleep(20);}throw Error(`Codex did not ${what}`);};
  const turns=method=>A.notes.filter(note=>note.method===method).map(note=>note.params.turn.id);
  const ended=()=>turns('turn/completed').length;
  const liveTurn=()=>turns('turn/started').findLast(id=>!turns('turn/completed').includes(id))??null;
  // Desktop's IPC, which starts and stops the chat's turns for Pause, Resume and a stopped chat's next message.
  closeIPC=await serveDesktopIPC(home,{
    'thread-follower-start-turn':({turnStart:{request}})=>A.call('turn/start',{threadId:request.threadId,input:request.input}),
    async 'thread-follower-interrupt-turn'({conversationId,expectedTurnId}) {
      if(liveTurn()!==expectedTurnId)return {ok:true,interruptedTurnId:null};
      const before=ended();await call('turn/interrupt',{threadId:conversationId,turnId:expectedTurnId});
      await until(()=>ended()>before,'end the interrupted turn');
      return {ok:true,interruptedTurnId:expectedTurnId};
    },
    'thread-follower-update-thread-settings':({condition})=>({applied:false,condition}),
  });
  let current=null,seen=0,handoff=[];
  // What reached the model since it was last called: the user's message, a hook's context or a Stop reason.
  const take=async timeout=>{
    const {request,resolve}=await until(()=>requests.shift(),'call the model',timeout);
    current={resolve,ended:ended()};
    const text=textOf(request.input.slice(seen));seen=request.input.length;
    handoff.push(...feedbackIds(text));
    return text;
  };
  // A held model call whose turn has ended since (Pause, a stop) is gone.
  const live=()=>{if(current&&ended()>current.ended){current.resolve([]);current=null;}return current;};
  // Answer the held model call; Codex calls the model again, or ends the turn.
  const answer=async items=>{
    const before=ended();current.resolve(items);current=null;
    return await until(()=>requests.length?'called':ended()>before?'ended':null,'go on after the model answered')==='called'?take():null;
  };
  // A tool call: Codex runs chill's PostToolUse hook, and its context reaches the model with the tool's output.
  const tool=()=>answer([kit.shellCall('true')]);
  // A turn chill started: from its message to an idle chat, or through Desktop. Codex takes a few seconds to see a queued one.
  const turnStarts=timeout=>take(timeout).then(()=>true,()=>false);
  const message=text=>({input:[{type:'text',text,text_elements:[]}],clientUserMessageId:randomUUID()});
  const thread=(await call('thread/start',{cwd:project})).thread.id;
  await call('thread/queue/add',{threadId:thread,...message('Start')});await take();await answer([kit.textItem('Ready.')]);
  const env={...process.env,CODEX_THREAD_ID:thread};
  const root=await createGoal({title:'A useful outcome'});
  await assignGoal(root.id,thread);
  return {
    ...userSide(root.id,()=>invalidateAgentObservation(thread)),
    async agentStartsResponse() {await call('thread/queue/add',{threadId:thread,...message('Work')});await take();await tool();},
    async agentEndsResponse() {
      if(!live()&&!(requests.length&&await turnStarts()))return null;
      const reason=await answer([kit.textItem('Done.')]);
      if(reason!==null)return reason;
      passTime();
      return null;
    },
    async userRunsLocalCommand() {},
    async agentIsInterrupted() {
      const before=ended();
      await call('turn/interrupt',{threadId:thread,turnId:liveTurn()});
      await until(()=>ended()>before,'end the interrupted turn');
      live();handoff=[];passTime();
    },
    async agentTakesFeedback() {
      if(!live()&&!await turnStarts(15000))return [];
      await tool();
      const ids=handoff;handoff=[];
      return ids;
    },
    strangerAnswers:()=>runWith(cli,['comment','--id',root.id,'--text','Not mine'],{env:{...env,CODEX_THREAD_ID:randomUUID()}}),
    agentReplies:(eventId,text)=>runWith(cli,['comment','--id',root.id,'--text',text],{env}),
    agentAsks:(ask,text)=>runWith(cli,['comment','--id',root.id,'--ask',ask,'--text',text],{env}),
    agentComments:text=>runWith(cli,['comment','--id',root.id,'--text',text],{env}),
    agentSelectsWork:()=>selectAgentWork(root.id,{env}),
  };
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
      // Claude Code writes the response's last message before its Stop hook runs, and passes it to the hook.
      await append([claudeEntry.text(randomUUID(),'Done.')]);
      // A blocked Stop hands over feedback that waited for the end, or holds the stop; the response then goes on.
      const output=await hook('Stop',{stop_hook_active:continuing,last_assistant_message:'Done.',background_tasks:background?[{id:'a1b2c3',type:'subagent',status:'running',description:'Review the change',agent_type:'general-purpose'}]:[]});
      continuing=output?.decision==='block';
      if(continuing){handoff=output.reason;return output.reason;}
      await append([claudeEntry.stop({uuid:randomUUID()})]);
      responding=false;handoff=null;
      return null;
    },
    // Claude Code writes the command and its output to the transcript, and runs no hook.
    async userRunsLocalCommand() {
      await append([claudeEntry.prompt(randomUUID(),'<command-name>/reload-skills</command-name>'),claudeEntry.prompt(randomUUID(),'<local-command-stdout>Reloaded 3 skills</local-command-stdout>')]);
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
    async agentAsks(ask,text) {await connection(['reply','--goal',root.id,'--ask',ask,'--text',text]);},
    async permissionPrompt() {return (await hook('PermissionRequest',{tool_name:'Bash',tool_input:{command:'ls'}}))?.hookSpecificOutput?.decision?.behavior??null;},
    agentComments:text=>runWith(cli,['comment','--id',root.id,'--text',text],{env}),
    agentSelectsWork:()=>selectAgentWork(root.id,{env:agentEnv}),
  };
  return session;
}

const win32Codex=process.platform==='win32'&&'Codex Desktop harness is macOS-only; fake-codex.mjs runs as an executable';

// Answering tool prompts (Autonomy approvals) and settings are Claude features. Pause goes through Desktop's IPC, which each Codex driver stands in for.
// Codex's Stop hook input names no background work, so chill cannot see it.
const codexCapabilities={approvals:false,pause:true,backgroundWork:false};
const appCodex=process.env.CHILL_SCENARIO_CODEX;
export const drivers=appCodex?[
  {name:'Codex app-server',start:t=>codexAppSession(t,appCodex),agentName:'Codex',pending:'handed',capabilities:codexCapabilities},
]:[
  {name:'Codex',skip:win32Codex,start:codexSession,agentName:'Codex',pending:'handed',capabilities:codexCapabilities},
  {name:'Claude Code',start:claudeSession,agentName:'Claude Code',pending:'saved',
    capabilities:{approvals:true,pause:true,backgroundWork:true}},
];
