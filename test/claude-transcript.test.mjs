import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFile,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {claudeMessagesSince,claudeModel,validTranscriptPath} from '../lib/claude-transcript.mjs';
import {claudeEntry,claudeLines} from './claude-fixtures.mjs';

const assistant=(uuid,content,timestamp,patch)=>claudeEntry.assistant(uuid,content,{timestamp,effort:'high',message:{model:'claude-opus-5-5'},...patch});

test('the transcript gives the model and the public text written since the work started',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'chill-transcript-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const path=join(dir,'session.jsonl');
 await writeFile(path,claudeLines([
  claudeEntry.prompt('p0','Earlier request'),
  assistant('a0',[{type:'text',text:'Before the work'}],'2026-10-14T05:00:00.000Z'),
  assistant('a1',[{type:'thinking',thinking:'private'},{type:'text',text:'Working on it'}],'2026-10-14T05:00:10.000Z'),
  assistant('s1',[{type:'text',text:'Subagent text'}],'2026-10-14T05:00:11.000Z',{isSidechain:true}),
  claudeEntry.tool('a2','Bash',{command:'ls'}),
  claudeEntry.toolResult('r2','toolu_a2','secret output'),
 ]));
 assert.deepEqual(await claudeModel(path),{model:'claude-opus-5-5',reasoning:'high'});
 const since='2026-10-14T05:00:05.000Z';
 assert.deepEqual((await claudeMessagesSince(path,since)).messages.map(m=>m.text),['Working on it'],'only public text since then, without thinking, tools or subagents');
 // New lines are read incrementally.
 await appendFile(path,claudeLines([assistant('a3',[{type:'text',text:'Done'}],'2026-10-14T05:01:00.000Z',{message:{model:'claude-sonnet-5-5'}})]));
 const later=await claudeMessagesSince(path,since);
 assert.deepEqual(later.messages.map(m=>m.text),['Working on it','Done']);
 assert.equal(later.settings.model,'claude-sonnet-5-5');
});

test('only absolute .jsonl transcript paths are read',async()=>{
 assert.equal(validTranscriptPath('relative.jsonl'),false);
 assert.equal(validTranscriptPath('/tmp/notes.txt'),false);
 assert.equal(await claudeModel('/missing/session.jsonl'),null);
 assert.equal(await claudeMessagesSince(undefined,'2026-10-14T05:00:00.000Z'),null);
});
