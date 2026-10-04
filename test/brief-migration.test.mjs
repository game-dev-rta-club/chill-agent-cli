import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {migrateBrief} from '../scripts/migrate-brief.mjs';
import {markdownText} from '../lib/markdown.mjs';
const save=(path,data)=>writeFile(path,JSON.stringify(data));
async function fixture(t,quote='formatted') {
 const root=await mkdtemp(join(tmpdir(),'chill-brief-migration-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const work=join(root,'workspace');await mkdir(join(work,'goals/1/overviews'),{recursive:true});await mkdir(join(work,'events'));
 await save(join(work,'schema.json'),{format:'goal-workspace',version:5});
 await writeFile(join(work,'goals/1/overview.md'),'Original');await save(join(work,'goals/1/overviews/v1.json'),{body:'Original',version:1});
 const text='A **formatted** sentence.';await save(join(work,'events/1.json'),{id:1,goalId:'1',text});
 await save(join(work,'events/2.json'),{id:2,goalId:'1',annotations:[{kind:'text',text:'Reply',source:{kind:'comment',eventId:1},anchor:{start:4,end:13,quote}},{kind:'text',text:'Brief reply',source:{kind:'overview',version:1},anchor:{start:0,end:8,quote:'Original'}}]});
 return {root,work,text};
}
test('one-time Brief conversion backs up data and relocates formatted comment annotations',async t=>{
 const {root,work,text}=await fixture(t),result=await migrateBrief(root);
 assert.equal(result.annotations,2);assert.equal(await readFile(join(work,'goals/1/brief.md'),'utf8'),'Original');
 assert.equal(await readFile(join(result.backup,'goals/1/overview.md'),'utf8'),'Original');
 const event=JSON.parse(await readFile(join(work,'events/2.json'),'utf8'));
 assert.equal(event.annotations[0].anchor.start,markdownText(text).indexOf('formatted'));assert.equal(event.annotations[1].source.kind,'brief');
 await assert.rejects(migrateBrief(root),/schema 5/);
});
test('unresolvable annotation stops conversion before modifying any workspace file',async t=>{
 const {root,work}=await fixture(t,'missing quote');await assert.rejects(migrateBrief(root),/left unchanged/);
 assert.equal(await readFile(join(work,'goals/1/overview.md'),'utf8'),'Original');assert.equal(JSON.parse(await readFile(join(work,'schema.json'),'utf8')).version,5);
});
