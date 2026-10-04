import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGoal,briefSource,updateBrief,readBrief,appendFeedback} from '../lib/goal-store.mjs';
import {briefHTML,briefText,briefDocument,briefReadableText} from '../lib/brief.mjs';
import {migrateBriefFormats} from '../scripts/migrate-brief-formats.mjs';

test('HTML Brief isolates author styling and preserves only static content',()=>{
 const source='<html><head><title>Not an annotation</title><style>body{color:red}</style></head><body><h1>Title</h1><script>alert(1)</script><p onclick="alert(1)">Readable</p><svg viewBox="0 0 20 20"><text>Diagram</text><rect width="20" height="20"/></svg><form><input/></form><img src="https://example.com/tracker"></body></html>';
 const html=briefHTML(source,'html');assert.ok(!/script|onclick|<form|<input|<img/.test(html));assert.match(html,/viewBox/);assert.equal(briefText(source,'html'),'TitleReadable');
 const doc=briefDocument(source);assert.match(doc,/body\{color:red\}/);assert.match(doc,/class="brief-body"/);assert.ok(!doc.includes('alert(1)'));
 assert.throws(()=>briefHTML('source','pdf'),/format/);assert.equal(briefReadableText('<h1>A</h1><p>B</p>','html'),'A\n\nB');
});
test('switching Brief formats keeps both originals, exact histories and HTML annotation coordinates',async t=>{
 const root=await mkdtemp(join(tmpdir(),'chill-brief-html-'));process.env.CHILL_AGENT_DATA_DIR=root;t.after(()=>rm(root,{recursive:true,force:true}));
 const goal=await createGoal({title:'Compare formats'});
 await writeFile(goal.briefPath,'# Markdown\n\nOriginal');const markdown=await updateBrief(goal.id);
 const source=await briefSource(goal.id,'html');assert.match(source.path,/brief.html$/);assert.equal((await briefSource(goal.id)).format,'markdown');
 const html='<style>p {color:green}</style><h1>HTML</h1><p>Readable answer</p>';
 await writeFile(source.path,html);const saved=await updateBrief(goal.id,'html');assert.equal(saved.format,'html');assert.equal(saved.version,2);
 assert.equal((await briefSource(goal.id)).format,'html');assert.equal((await updateBrief(goal.id)).changed,false);
 const canonical=briefText(html,'html'),start=canonical.indexOf('Readable');
 const event=await appendFeedback({goalId:goal.id,annotations:[{kind:'text',text:'Good',anchor:{start,end:start+8,quote:'Readable'},source:{kind:'brief',version:2}}]});assert.equal(event.annotations.length,1);
 assert.equal((await updateBrief(goal.id,'markdown')).version,3);assert.equal((await readBrief(goal.id,1)).body,markdown.body);assert.equal((await readBrief(goal.id,2)).body,html);
 await assert.rejects(updateBrief(goal.id,'pdf'),/format/);
});

test('one-time format conversion preserves snapshots, originals and conversations in a backup',async t=>{
 const root=await mkdtemp(join(tmpdir(),'chill-html-migration-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const work=join(root,'workspace');await mkdir(join(work,'goals/1/briefs'),{recursive:true});await mkdir(join(work,'events'));
 const old={goalId:1,version:1,body:'# Original',createdAt:'2026-10-04T00:00:00Z'};
 await writeFile(join(work,'schema.json'),JSON.stringify({format:'goal-workspace',version:6}));
 await writeFile(join(work,'goals/1/briefs/v1.json'),JSON.stringify(old));await writeFile(join(work,'goals/1/brief.md'),'# Edited');await writeFile(join(work,'events/2.json'),'{}');
 const result=await migrateBriefFormats(root);assert.equal(result.snapshots,1);
 assert.deepEqual(JSON.parse(await readFile(join(work,'goals/1/briefs/v1.json'))),{...old,format:'markdown'});
 assert.deepEqual(JSON.parse(await readFile(join(result.backup,'goals/1/briefs/v1.json'))),old);
 assert.equal(await readFile(join(work,'goals/1/brief.md'),'utf8'),'# Edited');assert.equal(await readFile(join(work,'events/2.json'),'utf8'),'{}');
 assert.equal(JSON.parse(await readFile(join(work,'schema.json'))).version,7);await assert.rejects(migrateBriefFormats(root),/schema 6/);
});
