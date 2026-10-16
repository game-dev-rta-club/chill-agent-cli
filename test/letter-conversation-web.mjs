// Opt-in browser integration trial. Uses a temporary workspace with no assigned chat.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/letter-conversation-web.mjs
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {promisify} from 'node:util';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=await mkdtemp(join(tmpdir(),'chill-letter-web-'));
const env={...process.env,CHILL_AGENT_DATA_DIR:root,PORT:'0'};
const execute=promisify(execFile),cli=new URL('../bin/chill-agent.mjs',import.meta.url).pathname;
const run=async(...args)=>JSON.parse((await execute(process.execPath,[cli,...args],{env})).stdout);
await run('create','--title','Small Goal');
const server=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname,'--local'],{env,stdio:['ignore','pipe','pipe']});
const url=await new Promise((resolve,reject)=>{server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});server.on('error',reject);server.on('exit',code=>reject(new Error(`Server exit ${code}`)));});
let browser;
try {
 browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1000,height:850}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const go=async(route='')=>{await page.goto(`${url}/#/goal/1${route}`);await page.reload();await page.locator('.conversation-form').waitFor();};
 const data=async()=> (await (await fetch(url+'/api/goals')).json())[0];
 const pending=async()=>{const g=await data();return g.conversation.filter(e=>e.type==='letter'&&!e.receivedAt&&!g.conversation.some(c=>c.author==='user'&&c.annotations?.some(n=>n.kind==='letter'&&n.source.eventId===e.id)));};
 const main=()=>page.locator('.conversation-form');
 const readCard=card=>card.evaluate(el=>{const pane=document.querySelector('main');pane.scrollTop+=el.getBoundingClientRect().top-pane.getBoundingClientRect().top-24;});
 const send=async(form)=>{const response=page.waitForResponse(r=>r.url().endsWith('/feedback')&&r.request().method()==='POST');await form.getByRole('button',{name:'Comment',exact:true}).click();assert.equal((await response).status(),201);if(await form.getAttribute('data-form')==='annotation')await form.waitFor({state:'hidden'});else await page.waitForFunction(()=>!document.querySelector('.conversation-form textarea').value);};
 await go();assert.match(await page.locator('.brief-body').innerText(),/No Deliverable/);
 await main().locator('textarea').fill('Before the Deliverable');await send(main());
 const path=join(root,'workspace/goals/1/deliverable.md');
 await writeFile(path,'## Current plan\n\nKeep this explanation current.\n\n<script>window.badBrief=true</script>\n<img src="https://example.com/tracker" onerror="window.badBrief=true">');
 await run('deliverable','update','--id','1');
 const a=await run('letter','--id','1','--title','First choice','--text','Which direction should we take?');
 const b=await run('letter','--id','1','--title','Second choice','--text','Which color would you like?');
 await go();assert.equal(await page.evaluate(()=>window.badBrief),undefined);assert.equal(await page.locator('.brief-body img').count(),0);
 const editor=()=>page.locator('.annotation-form');
 const select=(selector,start,end)=>page.evaluate(([selector,start,end])=>{
   document.activeElement?.blur();const el=document.querySelector(selector);const pane=document.querySelector('main');pane.scrollTop+=el.getBoundingClientRect().top-pane.getBoundingClientRect().top-120;const walk=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),r=document.createRange();let seen=0,node;
   while((node=walk.nextNode())){const next=seen+node.length;if(start>=seen&&start<=next&&!r.startContainer.isSameNode?.(node))r.setStart(node,start-seen);if(end>=seen&&end<=next){r.setEnd(node,end-seen);break;}seen=next;}
   window.getSelection().removeAllRanges();window.getSelection().addRange(r);document.dispatchEvent(new Event('selectionchange'));
 },[selector,start,end]);
 // A live refresh can replace the text under a selection, so select again until the action appears.
 const annotate=async(selector,start,end,text)=>{const action=page.locator('.annotation-action');for(let i=0;i<20&&!await action.isVisible();i++){await select(selector,start,end);await page.waitForTimeout(250);}await action.click();await editor().locator('textarea').fill(text);await editor().getByRole('button',{name:'Save',exact:true}).click();};
 // Users answer a Letter with an ordinary Comment; the agent records which one.
 const answered=async(letter,comment)=>{const r=await run('close-letter','--id','1','--event',String(letter.id),'--answer',String(comment.id));assert.equal(r.changed,true);await page.locator(`#event-${letter.id} .answered-label`).getByText('Replied',{exact:true}).waitFor({timeout:15000});};
 assert.equal(await page.getByRole('button',{name:'Answer',exact:true}).count(),0,'Letters have no Answer button');
 await main().locator('textarea').fill('Direction A, and blue for the color');
 await annotate('.brief-body p',0,4,'Keep this context');
 assert.equal(await main().locator('.draft-note').count(),1);assert.equal((await pending()).length,2);
 await send(main());const reply=(await data()).conversation.at(-1);
 assert.equal(reply.text,'Direction A, and blue for the color');assert.deepEqual(reply.annotations.map(n=>n.source),[{kind:'brief',version:1}]);
 assert.equal((await pending()).length,2,'a Comment alone does not close a Letter');
 await answered(a,reply);await answered(b,reply);
 assert.equal((await pending()).length,0);assert.equal(await main().locator('.draft-note').count(),0);
 // A failed Comment stays in its form; a retry saves it once.
 const c=await run('letter','--id','1','--title','Retry choice','--text','Can this answer survive a failure?');
 await go();await main().locator('textarea').fill('Try again');
 await page.route('**/api/goals/1/feedback',r=>r.fulfill({status:400,contentType:'application/json',body:'{"error":"Trial failure"}'}));
 await main().getByRole('button',{name:'Comment',exact:true}).click();await main().locator('.save-error').waitFor();
 assert.equal(await main().locator('textarea').inputValue(),'Try again');
 await page.unroute('**/api/goals/1/feedback');const before=(await data()).conversation.length;await send(main());
 const retried=await data();assert.equal(retried.conversation.length,before+1);await answered(c,retried.conversation.at(-1));
 // The same annotation list supports several notes, editing, and exclusions.
 await main().locator('textarea').fill('Keep this general comment');
 await annotate('.brief-body p',5,9,'Send this now');await annotate('.brief-body p',10,21,'Keep this for later');
 assert.equal(await main().locator('.draft-note').count(),2);
 await main().locator('.draft-note').filter({hasText:'Keep this for later'}).locator('input[type="checkbox"]').uncheck();
 await send(main());
 const bundle=(await data()).conversation.at(-1);assert.equal(bundle.text,'Keep this general comment');
 assert.deepEqual(bundle.annotations.map(({kind,text})=>({kind,text})),[{kind:'text',text:'Send this now'}]);
 assert.equal(await main().locator('.draft-note').count(),1);
 await main().locator('.draft-note [data-action="edit-draft-note"]').click();
 assert.equal(await editor().locator('textarea').inputValue(),'Keep this for later');
 assert.equal(await editor().locator('[data-editor-heading]').innerText(),'Annotation');
 await editor().locator('textarea').fill('Edited note');await editor().getByRole('button',{name:'Save',exact:true}).click();await main().locator('.draft-note input[type="checkbox"]').check();await send(main());
 assert.equal((await data()).conversation.at(-1).annotations[0].text,'Edited note');assert.equal(await main().locator('.draft-note').count(),0);
 await writeFile(path,'## Result\n\nThe same Goal has been updated.');await run('deliverable','update','--id','1');
 await go('/v1');await page.locator('.brief-body summary').click();assert.match(await page.locator('.brief-body').innerText(),/Keep this explanation/);
 // Annotating an old Deliverable saves its exact history source in the Goal Conversation.
 await annotate('.brief-body p',22,29,'Keep this context');
 await send(main());const last=(await data()).conversation.at(-1);assert.deepEqual(last.annotations[0].source,{kind:'brief',version:1});
 await go();await page.locator('.brief-body h2').waitFor();assert.match(await page.locator('.brief-body').innerText(),/Result/);
 const pendingLetter=await run('letter','--id','1','--title','手紙アイコンと長めのタイトルで、返信の使い心地を確かめてみましょう','--text','今のカードと、注釈と同じ返信欄はいかがですか？');
 await go();const pendingCard=page.locator(`#event-${pendingLetter.id}`);
 assert.equal(await pendingCard.locator('.letter-comment-title svg').count(),1);
 assert.equal(await pendingCard.locator('.event-meta').count(),0);
 await page.waitForFunction(id=>{
   const letter=document.querySelector(`#event-${id} article`),comment=document.querySelector('.timeline-entry:not(.letter-comment)');
   return letter&&comment&&getComputedStyle(letter).backgroundColor==='rgb(255, 255, 255)'&&getComputedStyle(letter).backgroundColor===getComputedStyle(comment).backgroundColor;
 },pendingLetter.id);
 // Letter title annotations use the common editor, with independent title offsets.
 await readCard(pendingCard);
 await page.evaluate(id=>{
   const title=document.querySelector(`#event-${id} [data-reply-field="title"]`),r=document.createRange();
   r.setStart(title.firstChild,0);r.setEnd(title.firstChild,2);
   window.getSelection().removeAllRanges();window.getSelection().addRange(r);document.dispatchEvent(new Event('selectionchange'));
 },pendingLetter.id);
 await page.locator('.annotation-action').click();
 await pendingCard.locator('[data-reply-field="title"] .annotation-mark.is-editing').waitFor();
 assert.equal(await pendingCard.locator('.event-text .annotation-mark').count(),0,'title offsets never mark the body');
 await editor().locator('textarea').fill('タイトルの注釈を試しています');
 await editor().getByRole('button',{name:'Save',exact:true}).click();
 await go();await pendingCard.locator('[data-reply-field="title"] .annotation-mark.is-draft').waitFor();
 await send(main());
 const titleAnnotation=(await data()).conversation.at(-1).annotations[0];
 assert.deepEqual(titleAnnotation.source,{kind:'comment',eventId:pendingLetter.id,field:'title'});
 assert.deepEqual(titleAnnotation.anchor,{start:0,end:2,quote:'手紙'});
 assert.equal((await pending()).length,1,'annotating a title does not answer the Letter');
 await go();await pendingCard.locator('[data-reply-field="title"] .annotation-mark').waitFor();
 await page.locator('[data-action="locate-note"]').filter({hasText:'タイトルの注釈を試しています'}).click();
 await page.locator('.annotation-preview').waitFor();
 assert.match(await page.locator('.annotation-preview').innerText(),/Letter title/);
 await page.locator('.annotation-preview [data-note-action="close"]').click();
 for(const width of [1000,390]){
   await page.setViewportSize({width,height:850});await readCard(pendingCard);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   assert.equal(await pendingCard.getByRole('button',{name:'Answer',exact:true}).count(),0);
   await page.screenshot({path:join(root,`view-${width}.png`)});
 }
 // A Comment that answers a Letter can attach an image.
 await main().locator('textarea').fill('画像でも回答できます');
 await main().locator('input[type="file"]').setInputFiles({name:'reply.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6N1cAAAAASUVORK5CYII=','base64')});
 await send(main());const pictured=(await data()).conversation.at(-1);
 assert.equal(pictured.attachmentIds?.length,1);await answered(pendingLetter,pictured);
 // Agent receipt updates an existing card in place; drafts and annotation IDs stay stable.
 const receiptLetter=await run('letter','--id','1','--title','Receipt test','--text','Receipt keeps this explanation.');
 for(let i=0;i<5;i++)await run('comment','--id','1','--text',`Later update ${i}`);
 await go();const receiptCard=page.locator(`#event-${receiptLetter.id}`);await readCard(receiptCard);
 await main().locator('textarea').fill('Keep this draft during receipt');
 await page.evaluate(id=>{const p=document.querySelector(`#event-${id} .event-text p`),r=document.createRange();r.setStart(p.firstChild,0);r.setEnd(p.firstChild,7);window.getSelection().removeAllRanges();window.getSelection().addRange(r);document.dispatchEvent(new Event('selectionchange'));},receiptLetter.id);
 await page.locator('.annotation-action').click();await editor().locator('textarea').fill('Still this Letter');
 await editor().getByRole('button',{name:'Save',exact:true}).click();
 const received=await run('close-letter','--id','1','--event',String(receiptLetter.id),'--reason','The discussion settles this question.');
 assert.equal(received.changed,true);
 await receiptCard.getByText('Received',{exact:true}).waitFor({timeout:15000});
 assert.equal(await receiptCard.count(),1);assert.equal(await receiptCard.locator(`[data-annotation-reply="${receiptLetter.id}"]:not([data-reply-field])`).count(),1);
 assert.equal(await receiptCard.locator('.is-answered').count(),1);assert.equal((await pending()).length,0);
 assert.equal(await main().locator('textarea').inputValue(),'Keep this draft during receipt');assert.equal(await main().locator('.draft-note').count(),1);
 assert.equal(await page.locator('.letter-title').count(),0,'Agent receipt removes the Letter from the Goal list');
 await send(main());assert.equal((await data()).conversation.at(-1).annotations[0].source.eventId,receiptLetter.id);
 await go(`/letter/${receiptLetter.id}`);await receiptCard.getByText('Received',{exact:true}).waitFor();

 const notice=await run('letter','--id','1','--no-reply','--title','Your result is ready','--text','Open the result when convenient.');
 for(const viewport of [{width:1200,height:900},{width:390,height:844}]){
  await page.setViewportSize(viewport);await go(`/letter/${notice.id}`);
  const card=page.locator(`#event-${notice.id}`);await readCard(card);
  assert.equal(await card.getByText('No reply needed',{exact:true}).count(),0);
  assert.equal(await card.getByRole('button',{name:'Comment',exact:true}).count(),0);
  assert.equal(await card.getByRole('button',{name:'Answer',exact:true}).count(),0);
  assert.equal(await card.getByText('No reply needed',{exact:true}).count(),0);
  assert.equal(await page.locator('.letter-title').count(),0);
  await page.screenshot({path:join(root,`notice-${viewport.width}.png`)});
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({result:'passed',screenshots:root,checks:['empty Goal comment','no Answer button','Comment answer recorded by agent','failure retry','bundled annotations','Deliverable history','annotation source','Letter title annotation and marker','HTML filtering','desktop and mobile layout','Agent receipt live update and annotation draft']}));
} finally {await browser?.close();if(server.exitCode===null){server.kill();await once(server,'exit');}if(process.env.KEEP_TRIAL!=='1')await rm(root,{recursive:true,force:true});}
