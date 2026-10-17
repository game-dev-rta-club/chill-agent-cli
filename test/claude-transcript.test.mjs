import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {claudeModel,claudeRunning,claudeTurn,claudeWork,validTranscriptPath} from '../lib/claude-transcript.mjs';

const line=value=>JSON.stringify(value)+'\n';
const assistant=(uuid,content,extra={})=>line({type:'assistant',uuid,timestamp:'2026-10-14T05:00:00.000Z',effort:'high',message:{model:'claude-opus-5-5',content},...extra});
const offer='11111111-2222-4333-8444-555555555555';

test('the transcript gives the model and the public text of the response that received feedback',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'chill-transcript-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const path=join(dir,'session.jsonl');
 await writeFile(path,[
  line({type:'user',uuid:'p0',message:{role:'user',content:'Earlier request'}}),
  assistant('a0',[{type:'text',text:'Before the feedback'}]),
  line({type:'attachment',uuid:'h1',attachment:{type:'hook_additional_context',content:[`[{"eventId":7,"offerId":"${offer}"}]`]}}),
  assistant('a1',[{type:'thinking',thinking:'private'},{type:'text',text:'Working on it'}]),
  assistant('s1',[{type:'text',text:'Subagent text'}],{isSidechain:true}),
  assistant('a2',[{type:'tool_use',name:'Bash',input:{command:'ls'}}]),
  line({type:'user',uuid:'r2',toolUseResult:{stdout:'secret output'},message:{role:'user',content:[{type:'tool_result',content:'secret output'}]}}),
 ].join(''));
 assert.deepEqual(await claudeModel(path),{model:'claude-opus-5-5',reasoning:'high'});
 const working=await claudeWork(path,offer);
 assert.equal(working.status,'working');assert.equal(working.endedAt,null);
 assert.deepEqual(working.messages.map(m=>m.text),['Working on it'],'only public text after the offer, without thinking, tools or subagents');
 // New lines are read incrementally; the response ends at its Stop summary.
 await appendFile(path,assistant('a3',[{type:'text',text:'Done'}])+line({type:'system',subtype:'stop_hook_summary',timestamp:'2026-10-14T05:01:00.000Z'})+line({type:'user',uuid:'p1',message:{role:'user',content:'Next request'}})+assistant('a4',[{type:'text',text:'Later answer'}],{message:{model:'claude-sonnet-5-5',content:[{type:'text',text:'Later answer'}]}}));
 const done=await claudeWork(path,offer);
 assert.equal(done.status,'completed');assert.equal(done.endedAt,'2026-10-14T05:01:00.000Z');
 assert.deepEqual(done.messages.map(m=>m.text),['Working on it','Done']);
 assert.equal((await claudeModel(path)).model,'claude-sonnet-5-5');
 assert.equal(working.turnId,'claude:p0','the response is named by the prompt that started it');
 assert.equal((await claudeTurn(path)).turnId,'claude:p1');
 assert.equal(await claudeWork(path,'00000000-0000-4000-8000-000000000000'),null);
});

test('a conversation is running from its last entry until Stop or an interrupt, and not when left stale',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'chill-transcript-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const path=join(dir,'session.jsonl'),stop=line({type:'system',subtype:'stop_hook_summary'});
 await writeFile(path,line({type:'user',uuid:'p0',message:{role:'user',content:'Do it'}})+assistant('a0',[{type:'tool_use',name:'Bash',input:{}}]));
 assert.equal(await claudeRunning(path),true);
 assert.equal(await claudeRunning(path,{now:()=>Date.now()+11*60*1000}),false,'no write for over 10 minutes');
 await appendFile(path,stop);assert.equal(await claudeRunning(path),false);
 // A background task notification reopens the conversation; subagent entries do not.
 await appendFile(path,assistant('s0',[{type:'text',text:'sub'}],{isSidechain:true}));assert.equal(await claudeRunning(path),false);
 await appendFile(path,line({type:'user',uuid:'n0',message:{role:'user',content:'<task-notification>done</task-notification>'}}));assert.equal(await claudeRunning(path),true);
 await appendFile(path,line({type:'user',uuid:'i0',message:{role:'user',content:[{type:'text',text:'[Request interrupted by user]'}]}}));assert.equal(await claudeRunning(path),false);
 assert.equal(await claudeRunning('/missing/session.jsonl'),null);
});

test('a response that ends with a background subagent still working stays Running until its notification',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'chill-transcript-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const path=join(dir,'session.jsonl'),stop=line({type:'system',subtype:'stop_hook_summary',timestamp:'2026-10-14T05:01:00.000Z'});
 await mkdir(join(dir,'session','subagents'),{recursive:true});
 const subagent=join(dir,'session','subagents','agent-a1b2c3.jsonl');await writeFile(subagent,'{}\n');
 await writeFile(path,[
  line({type:'user',uuid:'p0',message:{role:'user',content:'Run the test'}}),
  line({type:'attachment',uuid:'h1',attachment:{type:'hook_additional_context',content:[`[{"eventId":7,"offerId":"${offer}"}]`]}}),
  assistant('a0',[{type:'tool_use',id:'toolu_agent',name:'Agent',input:{prompt:'x',run_in_background:true}},{type:'tool_use',id:'toolu_bash',name:'Bash',input:{command:'serve',run_in_background:true}}]),
  line({type:'user',uuid:'r0',toolUseResult:{},message:{role:'user',content:[{type:'tool_result',tool_use_id:'toolu_agent',content:[{type:'text',text:'Async agent launched successfully.\nagentId: a1b2c3 (internal ID)'}]},{type:'tool_result',tool_use_id:'toolu_bash',content:'Command running in background with ID: b9z8y7.'}]}}),
  assistant('a1',[{type:'text',text:'Started; I will report when it ends.'}]),stop,
 ].join(''));
 assert.deepEqual(await claudeTurn(path).then(({running,background})=>({running,background})),{running:false,background:1},'the subagent counts; the background command does not');
 const work=await claudeWork(path,offer);
 assert.equal(work.status,'working');assert.equal(work.background,1);assert.equal(work.endedAt,'2026-10-14T05:01:00.000Z');
 assert.equal((await claudeWork(path,offer,{now:()=>Date.now()+11*60*1000})).status,'completed','a subagent whose transcript stopped being written ended with its app');
 await appendFile(path,line({type:'queue-operation',operation:'enqueue',content:'<task-notification>\n<task-id>a1b2c3</task-id>\n<status>completed</status>\n<note>This agent stopped with background work of its own still running.</note>\n</task-notification>'}));
 assert.equal((await claudeTurn(path)).background,1,'an interim notification while the subagent waits on its own work');
 // Claude Code queues the notification when the subagent ends.
 await appendFile(path,line({type:'queue-operation',operation:'enqueue',content:'<task-notification>\n<task-id>a1b2c3</task-id>\n<tool-use-id>toolu_agent</tool-use-id>\n<status>completed</status>\n</task-notification>'}));
 assert.equal((await claudeTurn(path)).background,0);
 assert.equal((await claudeWork(path,offer)).status,'completed');
});

test('only absolute .jsonl transcript paths are read',async()=>{
 assert.equal(validTranscriptPath('relative.jsonl'),false);
 assert.equal(validTranscriptPath('/tmp/notes.txt'),false);
 assert.equal(await claudeModel('/missing/session.jsonl'),null);
 assert.equal(await claudeWork(undefined,'x'),null);
});

test('an AutoContinue run is the response after the Stop that carried its request',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'chill-transcript-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const attempt='99999999-2222-4333-8444-555555555555',other='88888888-2222-4333-8444-555555555555';
 const request=id=>`Continue the Goal.\nchill monitor result --id 1 --attempt ${id} --outcome worked`;
 const path=join(dir,'session.jsonl');
 await writeFile(path,[
  assistant('a0',[{type:'text',text:'First answer'}]),
  line({type:'system',subtype:'stop_hook_summary',uuid:'s0',hookInfos:[{command:'chill'}],reason:request(attempt),timestamp:'2026-10-14T05:00:30.000Z'}),
  assistant('a1',[{type:'text',text:'Continued work'}]),
  assistant('a2',[{type:'tool_use',name:'Bash',input:{command:`chill monitor result --id 1 --attempt ${attempt} --outcome worked`}}]),
  line({type:'user',uuid:'r2',toolUseResult:{stdout:`--attempt ${attempt}`},message:{role:'user',content:[{type:'tool_result',content:'ok'}]}}),
  assistant('a3',[{type:'text',text:'Finished'}]),
  line({type:'system',subtype:'stop_hook_summary',uuid:'s1',timestamp:'2026-10-14T05:02:00.000Z'}),
  // A request written as its own message after the Stop also starts the run.
  line({type:'user',uuid:'p2',isMeta:true,message:{role:'user',content:`Stop hook feedback:\n${request(other)}`}}),
  assistant('a4',[{type:'text',text:'Second run'}]),
 ].join(''));
 const first=await claudeWork(path,attempt);
 assert.deepEqual(first.messages.map(m=>m.text),['Continued work','Finished']);assert.equal(first.status,'completed');
 const second=await claudeWork(path,other);
 assert.deepEqual(second.messages.map(m=>m.text),['Second run']);assert.equal(second.status,'working');
});
