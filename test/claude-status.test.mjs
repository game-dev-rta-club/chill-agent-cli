import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {captureClaudeEntry,claudeEntryPaths} from '../lib/claude-entry.mjs';
import {runClaudeAction,handleClaudeToolHook} from '../lib/claude-actions.mjs';
import {readClaudeConnectionStatus} from '../lib/claude-status.mjs';
import {createGoal,listGoals} from '../lib/goal-store.mjs';
import {readAgentStatus} from '../lib/agent-status.mjs';
import {agentMarkup} from '../public/agent-menu.js';
import {fileURLToPath} from 'node:url';
import {expectHidden} from './hidden-failures.mjs';
import {hookFor} from './claude-fixtures.mjs';
const exec=promisify(execFile);
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'claude-status-')),data=join(dir,'data'),cwd=join(dir,'project'),envFile=join(dir,'env');await mkdir(cwd);await writeFile(envFile,'');
 const old=process.env.CHILL_AGENT_DATA_DIR;process.env.CHILL_AGENT_DATA_DIR=data;
 t.after(async()=>{if(old===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=old;await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 const sessionId=randomUUID(),promptId=randomUUID();let clock=1000,env;
 const event=hookFor({session_id:sessionId,prompt_id:promptId,cwd});
 async function start(source='startup'){const r=await captureClaudeEntry(event('SessionStart',{source}),{cwd,env:{CLAUDE_ENV_FILE:envFile}});env={CHILL_AGENT_HARNESS:'claude-code',CHILL_AGENT_SESSION_ID:sessionId,CLAUDE_CODE_SESSION_ID:sessionId};}
 const hook=(name,patch={})=>handleClaudeToolHook(event(name,patch));
 const action=(name,payload)=>runClaudeAction(name,payload,{env});
 await start();await action('create-goal',{title:'Private native Goal',scope:'Private scope',criteria:'Same conversation'});const root=(await listGoals())[0];
 const read=()=>readClaudeConnectionStatus(root.connection,{now:()=>clock});
 const recordPath=claudeEntryPaths(data,sessionId).record;
 return {data,cwd,root,read,hook,start,action,recordPath,tick:value=>{clock=value;},env:()=>env};
}

test('status follows the last hook; resume preserves ownership and clear cannot borrow it',async t=>{
 const f=await fixture(t);assert.equal((await f.read()).state,'connected');await f.hook('Stop');assert.equal((await f.read()).state,'stopped');
 await f.hook('SessionEnd',{agent_id:'child'});assert.equal((await f.read()).state,'stopped');
 await f.hook('UserPromptSubmit');assert.equal((await f.read()).state,'connected');
 await f.hook('SessionEnd');assert.equal((await f.read()).state,'ended');
 await f.start('resume');assert.equal((await f.read()).state,'connected');
 await f.start('clear');const status=await f.read();assert.equal(status.state,'context-changed');assert.equal(status.observedAt,null);
});

test('child Agent menu and CLI show expose safe evidence without controls or private connection fields',async t=>{
 const f=await fixture(t),child=await createGoal({title:'Child',parentId:f.root.id});await f.hook('SessionEnd');
 const data=await readAgentStatus(child.id);assert.equal(data.rootId,f.root.id);assert.equal(data.agent.status.label,'Session ended');assert.deepEqual(data.capabilities,{settings:false,stop:false,resume:false});
 assert.doesNotMatch(JSON.stringify(data.agent),new RegExp(`${f.root.connection.sessionId}|${f.root.connection.contextId}|Private|transcript|cwd|generation`));
 const html=agentMarkup(data);assert.match(html,/Session ended/);assert.doesNotMatch(html,/<select|data-agent-settings|data-agent-extension|<progress/);
 const {stdout}=await exec(process.execPath,[fileURLToPath(new URL('../bin/chill-connection.mjs',import.meta.url)),'show'],{cwd:f.cwd,env:{...process.env,...f.env()}});assert.equal(JSON.parse(stdout).status.state,'ended');
 const injected=agentMarkup({...data,agent:{...data.agent,status:{label:'<img src=x>',detail:'<script>alert(1)</script>'}}});assert.doesNotMatch(injected,/<img|<script/);
});

test('missing and damaged records report unknown without changing their contents',async t=>{
 expectHidden(t,'claude-status.read');
 const f=await fixture(t);await writeFile(f.recordPath,'broken');assert.equal((await f.read()).state,'unknown');assert.equal(await readFile(f.recordPath,'utf8'),'broken');
 await rm(f.recordPath);assert.equal((await f.read()).state,'unknown');
});
