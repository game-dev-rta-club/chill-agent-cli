import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {captureClaudeEntry} from '../lib/claude-entry.mjs';
import {runClaudeAction} from '../lib/claude-actions.mjs';
import {recordClaudeWork} from '../lib/claude-agent-work.mjs';
import {claudeAskGuard,claudePlanApproval} from '../lib/claude-asks.mjs';
import {claudePermissionDecision} from '../lib/claude-permissions.mjs';
import {appendAgentComment,appendFeedback,listGoals,setGoalAutonomy} from '../lib/goal-store.mjs';
import {hookFor} from './claude-fixtures.mjs';

async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'claude-asks-test-')),data=join(dir,'data'),cwd=join(dir,'project');await mkdir(cwd);
  const old=process.env.CHILL_AGENT_DATA_DIR;process.env.CHILL_AGENT_DATA_DIR=data;
  t.after(async()=>{if(old===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=old;await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const envFile=join(dir,'env');await writeFile(envFile,'');
  const sessionId=randomUUID(),event=hookFor({session_id:sessionId,prompt_id:randomUUID(),cwd});
  const record=await captureClaudeEntry(event('SessionStart',{source:'startup'}),{cwd,env:{CLAUDE_ENV_FILE:envFile}});
  await runClaudeAction('create-goal',{title:'Long run',scope:'Test',criteria:'Never waits in the app'},{env:{CHILL_AGENT_HARNESS:'claude-code',CHILL_AGENT_SESSION_ID:sessionId}});
  const goal=(await listGoals())[0];
  await recordClaudeWork(sessionId,[{type:'started'},{type:'commented',goalId:goal.id}],{directory:data});
  const pre=(tool_name,tool_input={})=>claudeAskGuard(event('PreToolUse',{tool_name,tool_input}));
  return {event,goal,pre,connection:{harnessId:'claude-code',sessionId,contextId:record.contextId}};
}
const denied=output=>output?.hookSpecificOutput?.permissionDecision==='deny'?output.hookSpecificOutput.permissionDecisionReason:null;

test('a question or a task suggestion is refused and sent to the Web instead',async t=>{
  const f=await fixture(t);
  const question=denied(await f.pre('AskUserQuestion',{questions:[{question:'Which?',header:'Pick',options:[{label:'A'},{label:'B'}]}]}));
  assert.match(question,/nothing was asked[\s\S]*goal letter --id 1 /,'the question goes to the Goal it works on as a Letter');
  const box=denied(await f.pre('mcp__ccd_turn__wrap_up',{recap:'Done.',ask:'Commit it?',actions:[{label:'Commit',message:'Commit it'}]}));
  assert.match(box,/nothing was asked[\s\S]*goal letter --id 1 /,'a closing question in the next-step box goes to a Letter too');
  assert.ok(denied(await f.pre('mcp__ccd_turn__wrap_up',{recap:'Done.',actions:[{label:'Next',message:'Go on'}]})),'choice buttons alone are a question');
  assert.equal(await f.pre('mcp__ccd_turn__wrap_up',{recap:'Done.'}),null,'a recap alone goes through');
  const chip=denied(await f.pre('mcp__ccd_session__spawn_task',{title:'Fix the flaky test',prompt:'…',tldr:'…'}));
  assert.match(chip,/nothing was suggested[\s\S]*goal create --parent 1 /);
  assert.equal(await f.pre('Bash',{command:'ls'}),null,'other tools run');
  await setGoalAutonomy(f.goal.id,3);
  assert.equal(await claudePermissionDecision(f.event('PermissionRequest',{tool_name:'AskUserQuestion',tool_input:{}})),null,'Autonomy never answers a question');
});

test('a plan waits for a Web reply, then leaves plan mode without a prompt in the app',async t=>{
  const f=await fixture(t),permission=()=>claudePlanApproval(f.event('PermissionRequest',{tool_name:'ExitPlanMode',tool_input:{}}));
  await appendFeedback({goalId:f.goal.id,text:'Before the plan'});
  assert.match(denied(await f.pre('ExitPlanMode',{plan:'1. Do it'})),/plan was not shown[\s\S]*call ExitPlanMode again/);
  assert.equal(await permission(),null,'nothing is approved before the user replies');
  await appendAgentComment({goalId:f.goal.id,type:'letter',title:'Plan',text:'1. Do it'});
  assert.ok(denied(await f.pre('ExitPlanMode',{plan:'1. Do it'})),'the agent\'s own Letter is not a reply');
  await appendFeedback({goalId:f.goal.id,text:'Go ahead'});
  assert.equal(await f.pre('ExitPlanMode',{plan:'1. Do it'}),null,'after a reply it goes through');
  assert.equal((await permission())?.hookSpecificOutput?.decision?.behavior,'allow');
  assert.equal(await permission(),null,'the approval is used once');
  assert.ok(denied(await f.pre('ExitPlanMode',{plan:'2. Next'})),'a later plan asks again');
});

test('a conversation that owns no Goal is left alone',async t=>{
  const f=await fixture(t);
  assert.equal(await claudeAskGuard(f.event('PreToolUse',{session_id:randomUUID(),tool_name:'AskUserQuestion',tool_input:{}})),null);
});
