import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {captureClaudeEntry,claudeEntryPaths} from '../lib/claude-entry.mjs';
import {runClaudeAction} from '../lib/claude-actions.mjs';
import {recordClaudeWork} from '../lib/claude-agent-work.mjs';
import {settleClaudeQuestion} from '../lib/claude-question.mjs';
import {claudePermissionDecision,setClaudeApproveAll} from '../lib/claude-permissions.mjs';
import {listGoals,readFeedback} from '../lib/goal-store.mjs';
import {letterState} from '../public/letter-state.js';
import {readJson} from '../lib/storage.mjs';
import {hookFor} from './claude-fixtures.mjs';

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'claude-question-test-')),data=join(dir,'data'),cwd=join(dir,'project');await mkdir(cwd);
 const old=process.env.CHILL_AGENT_DATA_DIR;process.env.CHILL_AGENT_DATA_DIR=data;
 t.after(async()=>{if(old===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=old;await rm(dir,{recursive:true,force:true});});
 const envFile=join(dir,'env');await writeFile(envFile,'');
 const sessionId=randomUUID(),event=hookFor({session_id:sessionId,prompt_id:randomUUID(),cwd});
 const record=await captureClaudeEntry(event('SessionStart',{source:'startup'}),{cwd,env:{CLAUDE_ENV_FILE:envFile}});
 await runClaudeAction('create-goal',{title:'Pick a design',scope:'Test',criteria:'Asked'},{env:{CHILL_AGENT_HARNESS:'claude-code',CHILL_AGENT_SESSION_ID:sessionId}});
 const goal=(await listGoals())[0];
 await recordClaudeWork(sessionId,[{type:'started'},{type:'commented',goalId:goal.id}],{directory:data});
 const letters=async()=>(await readFeedback()).filter(e=>e.type==='letter').map(e=>({...e,status:letterState(e,[e])?.status}));
 return {data,event,goal,letters,recordPath:claudeEntryPaths(data,sessionId).record,connection:{harnessId:'claude-code',sessionId,contextId:record.contextId}};
}
const questions=[{question:'Which corner?',header:'Corner',multiSelect:false,options:[{label:'Left',description:'Near the start'},{label:'Right'}]}];

test('a question asked in Claude becomes a Letter on the Goal until it is answered there',async t=>{
 const f=await fixture(t),ask=f.event('PreToolUse',{tool_name:'AskUserQuestion',tool_use_id:'toolu_q1',tool_input:{questions}});
 await settleClaudeQuestion(ask);
 await settleClaudeQuestion(f.event('PermissionRequest',{tool_name:'AskUserQuestion',tool_input:{questions}}));
 const [letter,...others]=await f.letters();
 assert.equal(others.length,0,'the permission prompt of the same question adds no second Letter');
 assert.equal(letter.goalId,f.goal.id);assert.equal(letter.title,'Corner');assert.equal(letter.status,'open');
 assert.match(letter.text,/waiting for your answer in its own app[\s\S]*\*\*Which corner\?\*\*\n- Left — Near the start\n- Right/);
 await setClaudeApproveAll(f.connection,true);
 assert.equal(await claudePermissionDecision(f.event('PermissionRequest',{tool_name:'AskUserQuestion',tool_input:{questions}})),null,'Approve all never answers a question');
 await settleClaudeQuestion(f.event('PostToolUse',{tool_name:'AskUserQuestion',tool_use_id:'toolu_q1',tool_input:{questions},tool_response:{questions,answers:{'Which corner?':'Left'}}}));
 const [closed]=await f.letters();
 assert.equal(closed.status,'received');assert.equal(closed.receiveReason,'Answered in Claude: Which corner? = Left');
 assert.equal((await readJson(f.recordPath)).question,undefined);
});

test('a question that ends without an answer closes its Letter at the next step',async t=>{
 const f=await fixture(t);
 await settleClaudeQuestion(f.event('PreToolUse',{tool_name:'AskUserQuestion',tool_use_id:'toolu_q2',tool_input:{questions}}));
 await settleClaudeQuestion(f.event('Stop'));
 const [closed]=await f.letters();
 assert.equal(closed.status,'received');assert.equal(closed.receiveReason,'No longer asked in Claude.');
 await settleClaudeQuestion(f.event('Stop'));
 assert.equal((await f.letters()).length,1,'other steps add nothing');
});
