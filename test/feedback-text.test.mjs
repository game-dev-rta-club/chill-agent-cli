import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {goalRule} from '../lib/goal-rule.mjs';

test('Claude and Codex show the same feedback text, with the Goal rule, no guide path and their own commands',async t=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'chill-guide-')));t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 const guide=join(dir,'SKILL.md');await writeFile(guide,'# Guide');
 await mkdir(join(dir,'data','runtime'),{recursive:true});
 await writeFile(join(dir,'data','runtime','version-source.json'),JSON.stringify({version:1,versionFile:join(dir,'chill-agent.json'),agentGuide:guide}));
 const previous=process.env.CHILL_AGENT_DATA_DIR;process.env.CHILL_AGENT_DATA_DIR=join(dir,'data');t.after(()=>{if(previous===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=previous;});
 const {claudeFeedbackText}=await import('../lib/claude-actions.mjs'),{codexFeedbackText,codexCommand}=await import('../lib/agents/codex-work.mjs'),{command}=await import('../lib/chill-command.mjs');
 const event={id:3,goalId:'1',text:'Plain'},claude=await claudeFeedbackText([event]),codex=await codexFeedbackText([event]);
 for(const text of [claude,codex]){
  assert.ok(text.includes(goalRule));
  // A guide recorded at setup is not named: agents rarely opened it.
  assert.ok(!text.includes(guide));assert.doesNotMatch(text,/Workflow:/);
  // The agent replies itself: nothing it writes is posted for it.
  assert.match(text,/The user reads only the Web and waits for a reply on each Goal\. Reply on the Goal \(this answers it\): /);
  assert.doesNotMatch(text,/posted|final reply|current Goal|Skills named/);
 }
 // Only the commands differ.
 assert.equal(claude.replaceAll(`${command()} goal reply --id <goalId>`,'REPLY').replaceAll(`${command()} goal`,'CLI'),codex.replaceAll(`${codexCommand()} reply --id <goalId>`,'REPLY').replaceAll(codexCommand(),'CLI'));
 assert.ok(claude.includes(`${command()} goal show --id 1 --since 2 --format text --section context`));
 // Skills named in the feedback come with the file to read.
 const skill=join(process.env.HOME,'.claude','skills','grilling','SKILL.md');
 await mkdir(join(skill,'..'),{recursive:true});await writeFile(skill,'---\nname: grilling\n---\n');
 for(const text of [await claudeFeedbackText([{...event,text:'Use /grilling'}]),await codexFeedbackText([{...event,text:'Use /grilling'}])])
  assert.ok(text.includes(`Skills named in the feedback (invoke by name if your harness lists it; otherwise read the file and follow it):\n/grilling (user): ${skill}`));
});
