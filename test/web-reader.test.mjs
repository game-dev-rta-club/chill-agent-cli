import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {promisify} from 'node:util';
import test from 'node:test';
import {createGoalView} from '../public/goal-view.js';
import {fileURLToPath} from 'node:url';
const execute=promisify(execFile),cli=fileURLToPath(new URL('../bin/chill-agent.mjs',import.meta.url));
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'chill-web-')),env={...process.env,CHILL_AGENT_DATA_DIR:root,PORT:'0'};
 const run=async(...args)=>JSON.parse((await execute(process.execPath,[cli,...args],{env})).stdout);
 await run('create','--title','Goal');const body=join(root,'workspace/goals/1/deliverable.md');
 let count=0;const note=async()=>{await writeFile(body,`本文と注釈 ${++count}`);return run('canvas','update','--id','1');};
 let server,url;
 const stop=async()=>{if(server?.exitCode===null){server.kill();await once(server,'exit');}};
 const start=async()=>{server=spawn(process.execPath,[fileURLToPath(new URL('../server.mjs',import.meta.url)),'--local'],{env,stdio:['ignore','pipe','pipe']});
 url=await new Promise((resolve,reject)=>{server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});server.on('error',reject);server.on('exit',code=>reject(new Error(`Early exit ${code}`)));});};
 // Windows may release the stopped server's SQLite handles a moment after exit.
 t.after(async()=>{await stop();await rm(root,{recursive:true,force:true,maxRetries:10});});await start();
 const get=path=>fetch(url+path),post=(input,origin=url)=>fetch(url+'/api/goals/1/feedback',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(input)});
 return {root,body,run,note,start,stop,get,post,url:()=>url};
}
test('Web accepts empty Goal conversation, serves Markdown Deliverable and persists after restart',async t=>{
 const f=await fixture(t);
 const bundle=await f.get('/vendor/workspace-app.js');assert.equal(bundle.status,200);assert.match(bundle.headers.get('Cache-Control'),/private, no-cache/);
 const cached=await fetch(f.url()+'/vendor/workspace-app.js',{headers:{'If-None-Match':bundle.headers.get('ETag')}});assert.equal(cached.status,304);
 let [goal]=await(await f.get('/api/goals')).json();assert.deepEqual(goal.briefs,[]);
 assert.equal((await f.post({text:'Before Deliverable'})).status,201);
 await f.note();[goal]=await(await f.get('/api/goals')).json();assert.match(goal.briefs[0].html,/<p>本文/);
 assert.equal((await f.get('/api/plans')).status,404);
 const page=await f.get('/');assert.match(page.headers.get('Content-Security-Policy'),/script-src 'self'/);
 assert.equal((await f.post({version:1,text:'Legacy'})).status,400);
 assert.equal((await f.post({text:'Cross origin'},'https://example.com')).status,403);
 await f.stop();await f.start();[goal]=await(await f.get('/api/goals')).json();assert.equal(goal.conversation[0].text,'Before Deliverable');
 assert.equal((await f.get('/api/events?since=-1')).status,400);
 assert.equal((await f.get('/note-body.js')).status,404);assert.equal((await f.get('/brief-body.js')).status,200);
});
test('annotations reference exact replies; duplicates stay idempotent after a Deliverable update',async t=>{
 const f=await fixture(t);await f.note();await f.run('reply','--id','1','--text','返信の説明です');
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
test('pending Letter counts survive restart and close on the user\'s next comment from the Web',async t=>{
 const f=await fixture(t);await f.post({text:'Earlier comment'});
 const letter=await f.run('reply','--id','1','--ask','Choice','--text','Which?');
 await f.stop();await f.start();
 const view=async()=>{const [goal]=await(await f.get('/api/goals')).json();return createGoalView({'1':{...goal,children:[]}},'1',new Set());};
 assert.equal((await view()).letterCount('1'),1,'a comment before the Letter leaves it open');
 const answer=(await(await f.post({text:'Ordinary comment'})).json()).feedback;assert.equal((await view()).letterCount('1'),0);
 const [goal]=await(await f.get('/api/goals')).json();assert.equal(goal.conversation.find(e=>e.id===letter.id).answeredBy,answer.id);
});
test('a withdrawn Letter is exposed in the Web tree and event delta, and survives restart',async t=>{
 const f=await fixture(t),letter=await f.run('reply','--id','1','--ask','Settled choice','--text','Which?');
 const comment=await f.run('reply','--id','1','--text','The question settled itself.');
 const received=await f.run('close-letter','--id','1','--event',String(letter.id));assert.equal(received.status,'received');
 const delta=await(await f.get(`/api/events?since=${comment.changeId}`)).json();
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
 const served=await f.get('/api/images/'+ids[0]);assert.equal(served.headers.get('cache-control'),'private, max-age=31536000, immutable');
 assert.equal((await fetch(f.url()+'/api/images/'+ids[0],{headers:{'If-None-Match':served.headers.get('etag')}})).status,304);
 assert.deepEqual((await(await f.get(`/api/image-sizes?ids=${ids[0]},not-id`)).json()).sizes,{[ids[0]]:{width:1,height:1}});
 const saveHash=(id,thumbhash)=>fetch(f.url()+'/api/image-thumbhashes',{method:'POST',headers:{Origin:f.url(),'Content-Type':'application/json'},body:JSON.stringify({id,thumbhash})});
 assert.equal((await saveHash(ids[0],'not base64!')).status,400);assert.equal((await saveHash('not-id','AAAAAAAA')).status,400);
 assert.equal((await(await saveHash(ids[0],'YJqGPQw7sFlslqhFafSE+Q6oJ1h2iHB2Rw')).json()).thumbhash,'YJqGPQw7sFlslqhFafSE+Q6oJ1h2iHB2Rw');
 // The first ThumbHash stays.
 assert.equal((await(await saveHash(ids[0],'AAAAAAAAAAAA')).json()).thumbhash,'YJqGPQw7sFlslqhFafSE+Q6oJ1h2iHB2Rw');
 assert.deepEqual((await(await f.get(`/api/image-sizes?ids=${ids[0]}`)).json()).sizes[ids[0]],{width:1,height:1,thumbhash:'YJqGPQw7sFlslqhFafSE+Q6oJ1h2iHB2Rw'});
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
 await writeFile(f.body,source);await f.run('canvas','update','--id','1');
 const agent=await f.run('reply','--id','1','--text','Choose **this option**.');
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

test('compact Web snapshot keeps current content and Letters; older Deliverables load separately',async t=>{
 const f=await fixture(t);await f.note();await f.note();
 const letter=await f.run('reply','--id','1','--ask','Question','--text','Choose **one**.');
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
 const aLetter=await f.run('reply','--id','1','--ask','A','--text','Root question');
 const childLetter=await f.run('reply','--id',child.id,'--ask','Child','--text','Child question');
 await f.run('reply','--id',b.id,'--ask','B','--text','Other root question');
 const count=async id=>(await(await f.get(`/api/goals/${id}/letters/count`)).json());
 assert.deepEqual(await count(child.id),{rootId:'1',title:'Goal',count:2});
 assert.deepEqual(await count(b.id),{rootId:b.id,title:'Other root',count:1});
 await f.post({text:'An unrelated reply'});
 assert.equal((await count(child.id)).count,1,'a comment on the Root answers its Letter, not the child\'s');
 assert.equal((await f.run('show','--id','1')).conversation.find(e=>e.id===aLetter.id).answeredBy>aLetter.id,true);
 await f.run('close-letter','--id',child.id,'--event',String(childLetter.id));assert.equal((await count('1')).count,0);
 const patch=join(f.root,'reparent.json');await writeFile(patch,JSON.stringify({parentId:b.id}));
 await f.run('update','--id',child.id,'--input-file',patch);assert.equal((await count(child.id)).rootId,b.id);
 assert.equal((await f.get('/api/goals/999/letters/count')).status,404);
});

test('tab count adds unread notified replies to unanswered Letters; showing a Goal reads it on every device',async t=>{
 const f=await fixture(t),child=await f.run('create','--title','Child','--parent','1');
 const before=await f.run('reply','--id','1','--text','Saved before anyone read');
 const count=async id=>(await(await f.get(`/api/goals/${id}/letters/count`)).json()).count;
 const read=(id,through,origin=f.url())=>fetch(f.url()+`/api/goals/${id}/read`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({through})});
 assert.equal(await count('1'),0,'replies from before the first read are read');
 const result=await f.run('reply','--id','1','--text','Result'),quiet=await f.run('reply','--id',child.id,'--text','Not notified');
 const letter=await f.run('reply','--id',child.id,'--ask','Q','--text','Which one?');
 await f.post({text:'My own comment'});
 assert.equal(await count(child.id),1,'a reply nobody was notified of does not count');
 const claims=Object.fromEntries([before,result,letter].map(e=>[e.id,{at:Date.now(),rootId:'1',reply:true}]));
 await mkdir(join(f.root,'workspace/web-notifications'),{recursive:true});
 await writeFile(join(f.root,'workspace/web-notifications/1.json'),JSON.stringify({version:2,keys:null,devices:{},roots:{},jobs:{},claims}));
 assert.equal(await count(child.id),2,'a notified reply counts; a Letter counts once');
 let [root]=await(await f.get('/api/goals?view=web')).json();
 assert.deepEqual(root.notified,[result.id]);
 assert.equal((await read(child.id,letter.id)).status,200);
 assert.equal(await count('1'),2,'a read Letter still counts until answered');
 assert.equal((await read('1',result.id)).status,200);
 assert.equal(await count('1'),1);
 [root]=await(await f.get('/api/goals?view=web')).json();assert.deepEqual(root.notified,[]);
 assert.equal((await read('1',1)).status,200);assert.equal(await count('1'),1,'a read mark never moves back');
 await f.run('close-letter','--id',child.id,'--event',String(letter.id));assert.equal(await count('1'),0);
 assert.ok(quiet.id<letter.id);
 assert.equal((await read('1',5,'https://example.com')).status,403);
 assert.equal((await read('1',0)).status,400);
});

test('HTML message bodies survive saving and restart, with safe rendering and text annotations',async t=>{
 const f=await fixture(t),source='<p><strong>Readable</strong> message</p><details><summary>Details</summary><p>More</p></details><script>bad()</script><img src="https://example.com/track">';
 const event=await f.run('reply','--id','1','--text',source);
 await f.stop();await f.start();
 const [goal]=await(await f.get('/api/goals?view=web')).json();
 assert.equal(goal.conversation[0].text,source);
 assert.match(goal.conversation[0].html,/<strong>Readable<\/strong>/);assert.match(goal.conversation[0].html,/<details>/);
 assert.doesNotMatch(goal.conversation[0].html,/<script|<img|bad\(\)/);
 assert.equal((await f.post({annotations:[{kind:'text',source:{kind:'comment',eventId:event.id},anchor:{start:0,end:8,quote:'Readable'},text:'HTML note'}]})).status,201);
});

test('HTML diagram annotations retain the exact version and reject missing or foreign images',async t=>{
 const f=await fixture(t),source=join(f.root,'workspace/goals/1/deliverable.html');
 await writeFile(source,'<style>.drawing{color:#243b3e}</style><h1>Before</h1><svg class="drawing" viewBox="0 0 100 100" onload="bad()"><text x="10" y="20">First</text><script>bad()</script></svg>');
 await f.run('canvas','update','--id','1','--format','html');
 const page=await f.get('/api/goals/1/briefs/1/document'),doc=await page.text();assert.match(doc,/data-brief-svg="0"/);
 // A tunnel proxy must not rewrite the page (Cloudflare hides email addresses), or annotation offsets shift.
 assert.equal(page.headers.get('Cache-Control'),'no-store, no-transform');
 const svg=await f.get('/api/goals/1/briefs/1/svg/0');assert.equal(svg.status,200);assert.match(svg.headers.get('Content-Type'),/image\/svg\+xml/);
 const image=await svg.text();assert.match(image,/xmlns="http:\/\/www.w3.org\/2000\/svg"/);assert.match(image,/>First</);assert.doesNotMatch(image,/onload|<script|bad\(\)/);
 const note={kind:'image',source:{kind:'brief',version:1,svgIndex:0},rect:{x:.1,y:.1,width:.5,height:.5},imageName:'First diagram',text:'Diagram note'};
 const result=await f.post({annotations:[note]});assert.equal(result.status,201);assert.deepEqual((await result.json()).feedback.annotations[0].source,note.source);
 await writeFile(source,'<h1>After</h1><svg viewBox="0 0 100 100"><text>Replacement</text></svg>');await f.run('canvas','update','--id','1','--format','html');
 assert.match(await(await f.get('/api/goals/1/briefs/1/svg/0')).text(),/>First</);
 for(const source of [{kind:'brief',version:1,svgIndex:1},{kind:'brief',version:2,svgIndex:-1},{kind:'brief',version:99,svgIndex:0},{kind:'comment',version:1,svgIndex:0}])assert.equal((await f.post({annotations:[{...note,source}]})).status,400);
 assert.equal((await f.get('/api/goals/1/briefs/1/svg/1')).status,404);
});
test('files other than images attach with their name; only PDFs open inline',async t=>{
 const f=await fixture(t);
 const upload=(body,type,name)=>fetch(f.url()+'/api/images',{method:'POST',headers:{Origin:f.url(),'Content-Type':type,'X-File-Name':encodeURIComponent(name)},body});
 const pdf=await upload('%PDF-1.4 test','application/pdf','報告 report.pdf');assert.equal(pdf.status,201);const saved=await pdf.json();
 assert.equal(saved.name,'報告 report.pdf');
 assert.deepEqual(await(await f.get('/api/attachments/'+saved.id)).json(),{id:saved.id,mimeType:'application/pdf',name:'報告 report.pdf',image:false});
 const served=await f.get('/api/images/'+saved.id);assert.equal(served.headers.get('content-type'),'application/pdf');assert.match(served.headers.get('content-disposition'),/^inline;/);assert.equal(await served.text(),'%PDF-1.4 test');
 const html=await(await upload('<script>alert(1)</script>','text/html','../page.html')).json();assert.equal(html.name,'..page.html');
 const download=await f.get('/api/images/'+html.id);assert.equal(download.headers.get('content-type'),'application/octet-stream');assert.match(download.headers.get('content-disposition'),/^attachment;/);
 assert.equal((await upload('','text/plain','empty.txt')).status,400);
});
test('an agent-uploaded file keeps its name and extension when downloaded',async t=>{
 const f=await fixture(t),video=join(f.root,'rocket launch.mov'),bytes=Buffer.from('\0\0\0\x14ftypqt  not really a movie');
 await writeFile(video,bytes);
 const saved=await f.run('image','--file',video);assert.equal(saved.name,'rocket launch.mov');assert.equal(saved.src,`/api/images/${saved.id}`);
 const response=await f.get(saved.src);
 assert.equal(response.headers.get('Content-Disposition'),`attachment; filename*=UTF-8''${encodeURIComponent('rocket launch.mov')}`);
 assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
});
