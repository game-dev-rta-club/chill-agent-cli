import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('Claude and Codex show the same feedback text, with the recorded guide and their own commands',async t=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'chill-guide-')));t.after(()=>rm(dir,{recursive:true,force:true}));
 const guide=join(dir,'SKILL.md');await writeFile(guide,'# Guide');
 await mkdir(join(dir,'data','runtime'),{recursive:true});
 await writeFile(join(dir,'data','runtime','version-source.json'),JSON.stringify({version:1,versionFile:join(dir,'cli.json'),agentGuide:guide}));
 const previous=process.env.CHILL_AGENT_DATA_DIR;process.env.CHILL_AGENT_DATA_DIR=join(dir,'data');t.after(()=>{if(previous===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=previous;});
 const {claudeFeedbackText}=await import('../lib/claude-actions.mjs'),{codexFeedbackText,codexCommand}=await import('../lib/agents/codex-work.mjs'),{command}=await import('../lib/chill-command.mjs');
 const event={id:3,goalId:'1',text:'Plain'},claude=await claudeFeedbackText([event],'1'),codex=await codexFeedbackText([event],{current:'1'});
 // With no current Goal, as after feedback from several Goals, each Goal needs its own reply.
 for(const text of [await claudeFeedbackText([event,{...event,id:4,goalId:'2'}],null),await codexFeedbackText([event,{...event,id:4,goalId:'2'}])])
  assert.match(text,/The user reads only the Web and waits for a reply on each Goal\. Reply on each Goal: /);
 for(const text of [claude,codex]){
  assert.match(text,new RegExp(`Workflow: ${JSON.stringify(guide).replace(/[\\\\^$.*+?()[\]{}|]/g,'\\$&')}`));
  assert.match(text,/The user reads only the Web\. Your messages in this conversation are posted to Goal #1\. To reply on a specific Goal: /);
  assert.doesNotMatch(text,/final reply|Skills named/);
 }
 // Only the commands differ.
 assert.equal(claude.replaceAll(`${command()} connection reply --goal <goalId>`,'REPLY').replaceAll(`${command()} goal`,'CLI'),codex.replaceAll(`${codexCommand()} comment --id <goalId>`,'REPLY').replaceAll(codexCommand(),'CLI'));
 assert.ok(claude.includes(`${command()} goal show --id 1 --since 2 --format text --section context`));
 // Skills named in the feedback come with the file to read.
 const skill=join(process.env.HOME,'.claude','skills','grilling','SKILL.md');
 await mkdir(join(skill,'..'),{recursive:true});await writeFile(skill,'---\nname: grilling\n---\n');
 for(const text of [await claudeFeedbackText([{...event,text:'Use /grilling'}]),await codexFeedbackText([{...event,text:'Use /grilling'}])])
  assert.ok(text.includes(`Skills named in the feedback (invoke by name if your harness lists it; otherwise read the file and follow it):\n/grilling (user): ${skill}`));
});
