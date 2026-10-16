import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('Claude feedback points to the recorded project guide, as Codex delivery does',async t=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'chill-guide-')));t.after(()=>rm(dir,{recursive:true,force:true}));
 const guide=join(dir,'SKILL.md');await writeFile(guide,'# Guide');
 await mkdir(join(dir,'data','runtime'),{recursive:true});
 await writeFile(join(dir,'data','runtime','version-source.json'),JSON.stringify({version:1,versionFile:join(dir,'cli.json'),agentGuide:guide}));
 const previous=process.env.CHILL_AGENT_DATA_DIR;process.env.CHILL_AGENT_DATA_DIR=join(dir,'data');t.after(()=>{if(previous===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=previous;});
 const {feedbackContext}=await import('../lib/claude-actions.mjs');
 assert.match(feedbackContext([]),new RegExp(`Workflow: ${JSON.stringify(guide).replace(/[\\\\^$.*+?()[\]{}|]/g,'\\$&')}`));
 // Skills named in the feedback come with the file to read.
 assert.match(feedbackContext([],[],[{name:'grilling',scope:'user',file:'/h/.claude/skills/grilling/SKILL.md'}]),/Skills named in the feedback[^\n]*\n\/grilling \(user\): \/h\/\.claude\/skills\/grilling\/SKILL\.md/);
 assert.doesNotMatch(feedbackContext([]),/Skills named/);
});
