// Opt-in browser integration trial. Uses a temporary workspace with no assigned chat.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/letter-conversation-web.mjs
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {crc32,deflateSync} from 'node:zlib';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=await mkdtemp(join(tmpdir(),'chill-letter-web-'));
const env={...process.env,CHILL_AGENT_DATA_DIR:root,PORT:'0'};
const execute=promisify(execFile),cli=new URL('../bin/chill-agent.mjs',import.meta.url).pathname;
const png=(w,h)=>{const chunk=(type,data)=>{const b=Buffer.alloc(12+data.length);b.writeUInt32BE(data.length);b.write(type,4);data.copy(b,8);b.writeUInt32BE(crc32(b.subarray(4,8+data.length)),8+data.length);return b;};
 const head=Buffer.alloc(13);head.writeUInt32BE(w);head.writeUInt32BE(h,4);head.set([8,0,0,0,0],8);
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('IDAT',deflateSync(Buffer.alloc((w+1)*h,0x80))),chunk('IEND',Buffer.alloc(0))]);};
const run=async(...args)=>JSON.parse((await execute(process.execPath,[cli,...args],{env})).stdout);
// A Letter saved by the removed goal letter command, such as its no-reply notice.
const legacy=async input=>JSON.parse((await execute(process.execPath,['--input-type=module','-e',`import {appendAgentComment} from ${JSON.stringify(new URL('../lib/goal-store.mjs',import.meta.url).href)};console.log(JSON.stringify(await appendAgentComment(${JSON.stringify(input)})));`],{env})).stdout);
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
 await go();assert.match(await page.locator('.brief-body').innerText(),/No Canvas/);
 await main().locator('textarea').fill('Before the Deliverable');await send(main());
 const path=join(root,'workspace/goals/1/deliverable.md');
 await writeFile(path,'## Current plan\n\nKeep this explanation current.\n\n<script>window.badBrief=true</script>\n<img src="https://example.com/tracker" onerror="window.badBrief=true">');
 await run('canvas','update','--id','1');
 const a=await run('reply','--id','1','--ask','First choice','--text','Which direction should we take?');
 const b=await run('reply','--id','1','--ask','Second choice','--text','Which color would you like?');
 await go();assert.equal(await page.evaluate(()=>window.badBrief),undefined);assert.equal(await page.locator('.brief-body img').count(),0);
 const editor=()=>page.locator('.annotation-form');
 const select=(selector,start,end)=>page.evaluate(([selector,start,end])=>{
   document.activeElement?.blur();const el=document.querySelector(selector);const pane=document.querySelector('main');pane.scrollTop+=el.getBoundingClientRect().top-pane.getBoundingClientRect().top-120;const walk=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),r=document.createRange();let seen=0,node;
   while((node=walk.nextNode())){const next=seen+node.length;if(start>=seen&&start<=next&&!r.startContainer.isSameNode?.(node))r.setStart(node,start-seen);if(end>=seen&&end<=next){r.setEnd(node,end-seen);break;}seen=next;}
   window.getSelection().removeAllRanges();window.getSelection().addRange(r);document.dispatchEvent(new Event('selectionchange'));
 },[selector,start,end]);
 // A live refresh can replace the text under a selection, so select again until the action appears.
 const annotate=async(selector,start,end,text)=>{const action=page.locator('.annotation-action');for(let i=0;i<20&&!await action.isVisible();i++){await select(selector,start,end);await page.waitForTimeout(250);}await action.click();await editor().locator('textarea').fill(text);await editor().getByRole('button',{name:'Save',exact:true}).click();};
 // Users answer a Letter with an ordinary Comment on its Goal, which closes the Goal's open Letters.
 const answered=async letter=>{await page.locator(`#event-${letter.id} .answered-label`).getByText('Replied',{exact:true}).waitFor({timeout:15000});};
 assert.equal(await page.getByRole('button',{name:'Answer',exact:true}).count(),0,'Letters have no Answer button');
 await main().locator('textarea').fill('Direction A, and blue for the color');
 await annotate('.brief-body p',0,4,'Keep this context');
 assert.equal(await main().locator('.draft-note').count(),1);assert.equal((await pending()).length,2);
 await send(main());const reply=(await data()).conversation.at(-1);
 assert.equal(reply.text,'Direction A, and blue for the color');assert.deepEqual(reply.annotations.map(n=>n.source),[{kind:'brief',version:1}]);
 await answered(a);await answered(b);
 assert.equal((await pending()).length,0);assert.equal(await main().locator('.draft-note').count(),0);
 // A failed Comment stays in its form; a retry saves it once.
 const c=await run('reply','--id','1','--ask','Retry choice','--text','Can this answer survive a failure?');
 await go();await main().locator('textarea').fill('Try again');
 await page.route('**/api/goals/1/feedback',r=>r.fulfill({status:400,contentType:'application/json',body:'{"error":"Trial failure"}'}));
 await main().getByRole('button',{name:'Comment',exact:true}).click();await main().locator('.save-error').waitFor();
 assert.equal(await main().locator('textarea').inputValue(),'Try again');
 await page.unroute('**/api/goals/1/feedback');const before=(await data()).conversation.length;await send(main());
 const retried=await data();assert.equal(retried.conversation.length,before+1);await answered(c);
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
 await writeFile(path,'## Result\n\nThe same Goal has been updated.');await run('canvas','update','--id','1');
 await go('/v1');await page.locator('.brief-body summary').click();assert.match(await page.locator('.brief-body').innerText(),/Keep this explanation/);
 // Annotating an old Deliverable saves its exact history source in the Goal Conversation.
 await annotate('.brief-body p',22,29,'Keep this context');
 await send(main());const last=(await data()).conversation.at(-1);assert.deepEqual(last.annotations[0].source,{kind:'brief',version:1});
 await go();await page.locator('.brief-body h2').waitFor();assert.match(await page.locator('.brief-body').innerText(),/Result/);
 const pendingLetter=await run('reply','--id','1','--ask','手紙アイコンと長めのタイトルで、返信の使い心地を確かめてみましょう','--text','今のカードと、注釈と同じ返信欄はいかがですか？');
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
 // Hovering the button names its key, and E opens the annotation like a click.
 const action=page.locator('.annotation-action');await action.waitFor();await action.hover();
 await action.locator('.annotation-key-hint').waitFor({state:'visible'});assert.equal(await action.getAttribute('aria-keyshortcuts'),'E');
 await page.mouse.move(0,0);await page.keyboard.press('e');
 await pendingCard.locator('[data-reply-field="title"] .annotation-mark.is-editing').waitFor();
 await editor().locator('textarea').press('e');assert.equal(await editor().locator('textarea').inputValue(),'e','E types in the annotation');await editor().locator('textarea').fill('');
 assert.equal(await pendingCard.locator('.event-text .annotation-mark').count(),0,'title offsets never mark the body');
 await editor().locator('textarea').fill('タイトルの注釈を試しています');
 await editor().getByRole('button',{name:'Save',exact:true}).click();
 await go();await pendingCard.locator('[data-reply-field="title"] .annotation-mark.is-draft').waitFor();
 await send(main());
 const titleAnnotation=(await data()).conversation.at(-1).annotations[0];
 assert.deepEqual(titleAnnotation.source,{kind:'comment',eventId:pendingLetter.id,field:'title'});
 assert.deepEqual(titleAnnotation.anchor,{start:0,end:2,quote:'手紙'});
 assert.equal((await pending()).length,0,'a comment that annotates the title answers the Letter too');
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
 const imageLetter=await run('reply','--id','1','--ask','画像で答えられますか','--text','画像を添えて答えてください。');await go();
 await main().locator('textarea').fill('画像でも回答できます');
 await main().locator('input[type="file"]').setInputFiles({name:'reply.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6N1cAAAAASUVORK5CYII=','base64')});
 await send(main());const pictured=(await data()).conversation.at(-1);
 assert.equal(pictured.attachmentIds?.length,1);await answered(imageLetter);
 // Clicking an attached image opens the image annotation screen instead of the image file.
 await main().locator('input[type="file"]').setInputFiles({name:'wide.png',mimeType:'image/png',buffer:png(160,90)});
 await main().locator('textarea').fill('注釈したい画像');await send(main());const attached=(await data()).conversation.at(-1);
 const picture=page.locator(`#event-${attached.id} .annotatable-image`);await picture.scrollIntoViewIfNeeded();
 await picture.locator('img').click({position:{x:20,y:60}});
 const area=page.locator('.image-area-dialog');await area.waitFor({state:'visible'});assert.equal(page.url().startsWith(url),true);
 await area.getByRole('button',{name:'Whole image',exact:true}).click();await area.getByRole('button',{name:'Next',exact:true}).click();
 await editor().locator('textarea').fill('この画像について');await editor().getByRole('button',{name:'Save',exact:true}).click();
 await send(main());const imageNote=(await data()).conversation.at(-1).annotations[0];
 assert.deepEqual([imageNote.kind,imageNote.imageId,imageNote.text],['image',attached.attachmentIds[0],'この画像について']);
 // Agent receipt updates an existing card in place; drafts and annotation IDs stay stable.
 const receiptLetter=await run('reply','--id','1','--ask','Receipt test','--text','Receipt keeps this explanation.');
 for(let i=0;i<5;i++)await run('reply','--id','1','--text',`Later update ${i}`);
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

 // The user marks a Letter Done from its heading, without a Comment.
 const doneLetter=await run('reply','--id','1','--ask','Done test','--text','The user may close this.');
 await go();const doneCard=page.locator(`#event-${doneLetter.id}`);await readCard(doneCard);
 const eventsBefore=(await data()).conversation.length;
 await doneCard.getByRole('button',{name:'Done',exact:true}).click();
 // Shown from the response, before the next poll.
 await doneCard.locator('.letter-done-button.is-done').waitFor({timeout:1500});
 assert.equal(await doneCard.locator('.event-text').innerText(),'The user may close this.','The text stays after Done');assert.equal(await doneCard.locator('.is-answered').count(),1);
 assert.equal((await pending()).length,0);assert.equal((await data()).conversation.length,eventsBefore,'Done adds no Comment');
 assert.equal((await data()).conversation.find(e=>e.id===doneLetter.id).receivedBy,'user');
 // Pressing the check again takes the Done back: the Letter is open and counted again.
 await doneCard.locator('.letter-done-button.is-done').click();
 await doneCard.locator('.letter-done-button:not(.is-done)').waitFor({timeout:1500});
 assert.equal(await doneCard.locator('.is-answered').count(),0);assert.equal(await doneCard.locator('.event-text').innerText(),'The user may close this.');
 assert.equal((await pending()).length,1);assert.equal((await data()).conversation.find(e=>e.id===doneLetter.id).receivedBy,undefined);
 await doneCard.locator('.letter-done-button').click();await doneCard.locator('.letter-done-button.is-done').waitFor({timeout:1500});assert.equal((await pending()).length,0);

 const notice=await legacy({goalId:'1',type:'letter',replyRequired:false,title:'Your result is ready',text:'Open the result when convenient.'});
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
 assert.deepEqual(errors,[]);console.log(JSON.stringify({result:'passed',screenshots:root,checks:['empty Goal comment','no Answer button','Comment answers the Letters','failure retry','bundled annotations','Deliverable history','annotation source','E annotates','user Done and undo','Letter title annotation and marker','HTML filtering','desktop and mobile layout','Agent receipt live update and annotation draft']}));
} finally {await browser?.close();if(server.exitCode===null){server.kill();await once(server,'exit');}if(process.env.KEEP_TRIAL!=='1')await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
