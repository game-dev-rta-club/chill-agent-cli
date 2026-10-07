import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {promisify} from 'node:util';
import test from 'node:test';
import {createGoalView} from '../public/goal-view.js';
const execute=promisify(execFile),cli=new URL('../bin/chill-agent.mjs',import.meta.url).pathname;
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'chill-web-')),env={...process.env,CHILL_AGENT_DATA_DIR:root,PORT:'0'};
 const run=async(...args)=>JSON.parse((await execute(process.execPath,[cli,...args],{env})).stdout);
 await run('create','--title','Goal');const body=join(root,'workspace/goals/1/brief.md');
 let count=0;const note=async()=>{await writeFile(body,`本文と注釈 ${++count}`);return run('brief','update','--id','1');};
 let server,url;
 const stop=async()=>{if(server?.exitCode===null){server.kill();await once(server,'exit');}};
 const start=async()=>{server=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname,'--local'],{env,stdio:['ignore','pipe','pipe']});
 url=await new Promise((resolve,reject)=>{server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});server.on('error',reject);server.on('exit',code=>reject(new Error(`Early exit ${code}`)));});};
 t.after(async()=>{await stop();await rm(root,{recursive:true,force:true});});await start();
 const get=path=>fetch(url+path),post=(input,origin=url)=>fetch(url+'/api/goals/1/feedback',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(input)});
 return {root,body,run,note,start,stop,get,post,url:()=>url};
}
test('Web accepts empty Goal conversation, serves Markdown Brief and persists after restart',async t=>{
 const f=await fixture(t);
 const bundle=await f.get('/vendor/workspace-app.js');assert.equal(bundle.status,200);assert.match(bundle.headers.get('Cache-Control'),/private, no-cache/);
 const cached=await fetch(f.url()+'/vendor/workspace-app.js',{headers:{'If-None-Match':bundle.headers.get('ETag')}});assert.equal(cached.status,304);
 let [goal]=await(await f.get('/api/goals')).json();assert.deepEqual(goal.briefs,[]);
 assert.equal((await f.post({text:'Before Brief'})).status,201);
 await f.note();[goal]=await(await f.get('/api/goals')).json();assert.match(goal.briefs[0].html,/<p>本文/);
 assert.equal((await f.get('/api/plans')).status,404);
 const page=await f.get('/');assert.match(page.headers.get('Content-Security-Policy'),/script-src 'self'/);
 assert.equal((await f.post({version:1,text:'Legacy'})).status,400);
 assert.equal((await f.post({text:'Cross origin'},'https://example.com')).status,403);
 await f.stop();await f.start();[goal]=await(await f.get('/api/goals')).json();assert.equal(goal.conversation[0].text,'Before Brief');
 assert.equal((await f.get('/api/events?since=-1')).status,400);
 assert.equal((await f.get('/note-body.js')).status,404);assert.equal((await f.get('/brief-body.js')).status,200);
});
test('annotations reference exact replies; duplicates stay idempotent after an Brief update',async t=>{
 const f=await fixture(t);await f.note();await f.run('comment','--id','1','--text','返信の説明です');
 const annotation={kind:'text',source:{kind:'comment',eventId:1},anchor:{start:0,end:2,quote:'返信'},text:'詳しく'};
 const payload={annotations:[annotation],requestId:'reply-request-001'};
 const replies=await Promise.all([f.post(payload),f.post(payload),f.post(payload)]);
 for(const response of replies){assert.equal(response.status,201);assert.equal((await response.json()).feedback.changeId,2);}
 for(const bad of [{...annotation,source:{kind:'comment',eventId:2}},{...annotation,source:{kind:'comment',eventId:99}},{...annotation,source:{kind:'unknown'}},{...annotation,anchor:{start:0,end:2,quote:'違う'}}])
 assert.equal((await f.post({annotations:[bad]})).status,400);
 assert.equal((await f.post({...payload,text:'Changed request'})).status,400);
 await f.note();assert.equal((await f.post({annotations:[annotation]})).status,201);
 assert.equal((await(await f.post(payload)).json()).feedback.changeId,2);
 assert.equal((await f.post({text:'Historical reply'})).status,201);
 assert.equal((await f.post({text:'',annotations:[]})).status,400);
 assert.equal((await f.post({text:'Old protocol',decision:'accept'})).status,400);
});
test('pending Letter counts survive restart and close only on explicit answers',async t=>{
 const f=await fixture(t),letter=await f.run('letter','--id','1','--title','Choice','--text','Which?');
 await f.post({text:'Ordinary comment'});await f.stop();await f.start();
 const view=async()=>{const [goal]=await(await f.get('/api/goals')).json();return createGoalView({'1':{...goal,children:[]}},'1',new Set());};
 assert.equal((await view()).letterCount('1'),1);
 await f.post({annotations:[{kind:'letter',source:{kind:'comment',eventId:letter.id},text:'A'}]});assert.equal((await view()).letterCount('1'),0);
});
test('Agent receipt is exposed in the Web tree and event delta, and survives restart',async t=>{
 const f=await fixture(t),letter=await f.run('letter','--id','1','--title','Settled choice','--text','Which?');
 const feedback=await(await f.post({text:'The discussion is sufficient.'})).json();
 const received=await f.run('close-letter','--id','1','--event',String(letter.id));
 const delta=await(await f.get(`/api/events?since=${feedback.feedback.changeId}`)).json();
 assert.equal(delta.cursor,received.changeId);assert.equal(delta.events.length,1);assert.equal(delta.events[0].id,letter.id);
 const view=async()=>{const [goal]=await(await f.get('/api/goals')).json();return createGoalView({'1':{...goal,children:[]}},'1',new Set());};
 assert.equal((await view()).letterCount('1'),0);
 await f.stop();await f.start();assert.equal((await view()).letterCount('1'),0);
 const [goal]=await(await f.get('/api/goals')).json();assert.equal(goal.conversation.length,2);assert.equal(goal.conversation[0].receivedAt,received.receivedAt);
});
test('multiple images and rectangle annotations persist, reject foreign images and expose CLI paths',async t=>{
 const f=await fixture(t);await f.note();const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==','base64');
 const upload=body=>fetch(f.url()+'/api/images',{method:'POST',headers:{Origin:f.url(),'Content-Type':'image/png'},body});
 const ids=[];for(let i=0;i<3;i++){const r=await upload(png);assert.equal(r.status,201);ids.push((await r.json()).id);}
 assert.equal((await upload('not png')).status,400);
 assert.deepEqual(Buffer.from(await(await f.get('/api/images/'+ids[0])).arrayBuffer()),png);
 assert.equal((await f.get('/api/images/not-id')).status,404);
 assert.equal((await f.post({attachmentIds:ids.slice(0,2)})).status,201);
 const rect={x:.1,y:.2,width:.3,height:.4}, image={kind:'image',imageId:ids[0],rect,text:'画像のメモ',imageName:'添付'};
 const text={kind:'text',source:{kind:'brief',version:1},anchor:{start:0,end:2,quote:'本文'},text:'',attachmentIds:[ids[1]]};
 const r=await f.post({annotations:[image,text]});assert.equal(r.status,201);assert.equal((await r.json()).feedback.annotations.length,2);
 for(const bad of [{...image,imageId:ids[2]},{...image,rect:{...rect,x:.9}},{...image,imageName:12}]) assert.equal((await f.post({annotations:[bad]})).status,400);
 const shown=await f.run('show','--id','1');assert.equal(shown.attachments.length,2);assert.ok(shown.attachments.every(a=>a.path.endsWith('.png')));
 assert.deepEqual(shown.conversation[0].attachmentIds,ids.slice(0,2));
});
test('Markdown annotations validate rendered text and API deltas render both authors',async t=>{
 const f=await fixture(t),source='## Result\n\nA **formatted** result.';
 await writeFile(f.body,source);await f.run('brief','update','--id','1');
 const agent=await f.run('comment','--id','1','--text','Choose **this option**.');
 const [goal]=await(await f.get('/api/goals')).json();
 assert.match(goal.briefs[0].html,/<details/);assert.match(goal.conversation[0].html,/<strong>this option/);
 const annotations=[{kind:'text',source:{kind:'comment',eventId:agent.id},anchor:{start:7,end:18,quote:'this option'},text:'Selected'},
 {kind:'text',source:{kind:'brief',version:1},anchor:{start:9,end:18,quote:'formatted'},text:'Current outcome'}];
 const response=await f.post({text:'**My answer**',annotations});assert.equal(response.status,201);
 const saved=(await response.json()).feedback;assert.match(saved.html,/<strong>My answer/);
 const delta=await(await f.get(`/api/events?since=${agent.changeId}`)).json();assert.match(delta.events[0].html,/<strong>My answer/);
 assert.equal((await f.post({annotations:[{...annotations[1],anchor:{start:9,end:18,quote:'wrong'}}]})).status,400);
 assert.equal((await f.get('/markdown-view.js')).status,200);assert.equal((await f.get('/vendor/mermaid.js')).status,200);
 assert.equal((await f.get('/overview-body.js')).status,404);
});

test('compact Web snapshot keeps current content and Letters; older Briefs load separately',async t=>{
 const f=await fixture(t);await f.note();await f.note();
 const letter=await f.run('letter','--id','1','--title','Question','--text','Choose **one**.');
 let [goal]=await(await f.get('/api/goals?view=web')).json();
 assert.equal(goal.briefs.length,2);assert.equal(goal.briefs[0].html,undefined);
 assert.equal(goal.briefs[1].body,undefined);assert.match(goal.briefs[1].html,/本文と注釈 2/);
 assert.equal(goal.briefPath,undefined);assert.match(goal.conversation[0].html,/<strong>one/);
 const old=await(await f.get('/api/goals/1/briefs/1')).json();assert.match(old.html,/本文と注釈 1/);
 assert.equal((await f.get('/api/goals/1/briefs/999')).status,404);
 const gzip=await fetch(f.url()+'/api/goals?view=web',{headers:{'Accept-Encoding':'gzip'}});
 assert.equal(gzip.headers.get('Content-Encoding'),'gzip');assert.equal((await gzip.json())[0].id,'1');
 await f.run('close-letter','--id','1','--event',String(letter.id));
 [goal]=await(await f.get('/api/goals?view=web')).json();
 assert.ok(goal.conversation[0].receivedAt,'cached HTML must not freeze Letter state');
 assert.equal(createGoalView({'1':{...goal,children:[]}},'1',new Set()).letterCount('1'),0);
});

test('tab count follows the current Root, including child Letters, answers and reparenting',async t=>{
 const f=await fixture(t),b=await f.run('create','--title','Other root'),child=await f.run('create','--title','Child','--parent','1');
 const aLetter=await f.run('letter','--id','1','--title','A','--text','Root question');
 const childLetter=await f.run('letter','--id',child.id,'--title','Child','--text','Child question');
 await f.run('letter','--id',b.id,'--title','B','--text','Other root question');
 const count=async id=>(await(await f.get(`/api/goals/${id}/letters/count`)).json());
 assert.deepEqual(await count(child.id),{rootId:'1',title:'Goal',count:2});
 assert.deepEqual(await count(b.id),{rootId:b.id,title:'Other root',count:1});
 await f.post({text:'An unrelated reply'});assert.equal((await count('1')).count,2);
 await f.post({annotations:[{kind:'letter',source:{kind:'comment',eventId:aLetter.id},text:'Answered'}]});
 assert.equal((await count(child.id)).count,1);
 await f.run('close-letter','--id',child.id,'--event',String(childLetter.id));assert.equal((await count('1')).count,0);
 const patch=join(f.root,'reparent.json');await writeFile(patch,JSON.stringify({parentId:b.id}));
 await f.run('update','--id',child.id,'--input-file',patch);assert.equal((await count(child.id)).rootId,b.id);
 assert.equal((await f.get('/api/goals/999/letters/count')).status,404);
});

test('HTML message bodies survive saving and restart, with safe rendering and text annotations',async t=>{
 const f=await fixture(t),source='<p><strong>Readable</strong> message</p><details><summary>Details</summary><p>More</p></details><script>bad()</script><img src="https://example.com/track">';
 const event=await f.run('comment','--id','1','--text',source);
 await f.stop();await f.start();
 const [goal]=await(await f.get('/api/goals?view=web')).json();
 assert.equal(goal.conversation[0].text,source);
 assert.match(goal.conversation[0].html,/<strong>Readable<\/strong>/);assert.match(goal.conversation[0].html,/<details>/);
 assert.doesNotMatch(goal.conversation[0].html,/<script|<img|bad\(\)/);
 assert.equal((await f.post({annotations:[{kind:'text',source:{kind:'comment',eventId:event.id},anchor:{start:0,end:8,quote:'Readable'},text:'HTML note'}]})).status,201);
});

test('HTML diagram annotations retain the exact version and reject missing or foreign images',async t=>{
 const f=await fixture(t),source=join(f.root,'workspace/goals/1/brief.html');
 await writeFile(source,'<style>.drawing{color:#243b3e}</style><h1>Before</h1><svg class="drawing" viewBox="0 0 100 100" onload="bad()"><text x="10" y="20">First</text><script>bad()</script></svg>');
 await f.run('brief','update','--id','1','--format','html');
 const doc=await(await f.get('/api/goals/1/briefs/1/document')).text();assert.match(doc,/data-brief-svg="0"/);
 const svg=await f.get('/api/goals/1/briefs/1/svg/0');assert.equal(svg.status,200);assert.match(svg.headers.get('Content-Type'),/image\/svg\+xml/);
 const image=await svg.text();assert.match(image,/xmlns="http:\/\/www.w3.org\/2000\/svg"/);assert.match(image,/>First</);assert.doesNotMatch(image,/onload|<script|bad\(\)/);
 const note={kind:'image',source:{kind:'brief',version:1,svgIndex:0},rect:{x:.1,y:.1,width:.5,height:.5},imageName:'First diagram',text:'Diagram note'};
 const result=await f.post({annotations:[note]});assert.equal(result.status,201);assert.deepEqual((await result.json()).feedback.annotations[0].source,note.source);
 await writeFile(source,'<h1>After</h1><svg viewBox="0 0 100 100"><text>Replacement</text></svg>');await f.run('brief','update','--id','1','--format','html');
 assert.match(await(await f.get('/api/goals/1/briefs/1/svg/0')).text(),/>First</);
 for(const source of [{kind:'brief',version:1,svgIndex:1},{kind:'brief',version:2,svgIndex:-1},{kind:'brief',version:99,svgIndex:0},{kind:'comment',version:1,svgIndex:0}])assert.equal((await f.post({annotations:[{...note,source}]})).status,400);
 assert.equal((await f.get('/api/goals/1/briefs/1/svg/1')).status,404);
});
