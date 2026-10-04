import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {briefText} from '../lib/brief.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=await mkdtemp(join(tmpdir(),'chill-html-web-')),env={...process.env,CHILL_AGENT_DATA_DIR:root,PORT:'0'};
const execute=promisify(execFile),cli=new URL('../bin/chill-agent.mjs',import.meta.url).pathname;
const run=async(...args)=>JSON.parse((await execute(process.execPath,[cli,...args],{env})).stdout);
await run('create','--title','Goal・Plan・Letterとバージョンの役割を整理する');
await writeFile(join(root,'workspace/goals/1/brief.md'),'# Markdown remains\n\nOriginal explanation');await run('brief','update','--id','1');
const source=await readFile(new URL('../docs/examples/goal-7-brief.html',import.meta.url),'utf8');
const path=await run('brief','path','--id','1','--format','html');await writeFile(path.path,source);await run('brief','update','--id','1','--format','html');
const server=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname,'--local'],{env,stdio:['ignore','pipe','pipe']});
const url=await new Promise((resolve,reject)=>{server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});server.on('error',reject);server.on('exit',code=>reject(new Error(`Server exit ${code}`)));});
let browser;
try {
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1056,height:1000}}),errors=[];
 page.setDefaultTimeout(10000);
 page.on('pageerror',e=>errors.push(e.message));await page.goto(url+'/#/goal/1');await page.locator('.conversation-form').waitFor();
 const frame=page.frameLocator('.html-brief-frame'),heading=frame.getByRole('heading',{name:/任せた仕事に、.*いつでも戻れる。/});await heading.waitFor();
 const doc=await fetch(url+'/api/goals/1/briefs/2/document');assert.match(doc.headers.get('content-security-policy'),/script-src 'none'/);
 assert.equal(await page.locator('.html-brief-frame').getAttribute('sandbox'),'allow-same-origin');
 assert.equal(await page.locator('.html-brief-frame').evaluate(el=>el.contentDocument.querySelectorAll('script,form').length),0);
 const canonical=await page.locator('.html-brief-frame').evaluate(el=>{const root=el.contentDocument.querySelector('.brief-body'),w=el.contentDocument.createTreeWalker(root,4,{acceptNode:n=>n.parentElement.closest('svg,style,script')?2:1});let text='',n;while(n=w.nextNode())text+=n.textContent;return text;});assert.equal(canonical,briefText(source,'html'));
 assert.ok((await page.locator('.html-brief-frame').boundingBox()).height>2000);
 await page.screenshot({path:'/tmp/chill-html-brief-desktop.png'});
 // Annotate inside the iframe, using the existing parent editor and sender.
 const quote='Briefに作業ログを積まず';
 await frame.getByText(/Briefに作業ログを積まず/).scrollIntoViewIfNeeded();
 // Simulate delayed iframe selection notifications. Completing a selection must still
 // expose the action, before the user focuses anything in the parent document.
 await page.locator('.html-brief-frame').evaluate((el,quote)=>{
  const d=el.contentDocument,n=[...d.querySelectorAll('.takeaway')].find(p=>p.textContent.includes(quote)).firstChild,r=d.createRange();
  d.addEventListener('selectionchange',e=>e.stopImmediatePropagation(),true);
  r.setStart(n,0);r.setEnd(n,quote.length);const selection=el.contentWindow.getSelection();
  selection.removeAllRanges();selection.addRange(r);el.focus();
  n.parentElement.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));
 },quote);
 await frame.locator('.annotation-action').waitFor({state:'visible',timeout:2000});
 assert.equal(await page.locator('.html-brief-frame').evaluate(el=>el.contentWindow.getSelection().toString()),quote);
 assert.equal(await page.evaluate(()=>document.activeElement.className),'html-brief-frame');
 // A keyboard-completed selection also works without selectionchange or blur.
 await page.locator('.html-brief-frame').evaluate(el=>{el.contentWindow.getSelection().removeAllRanges();el.contentDocument.body.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'ArrowRight'}));});
 await frame.locator('.annotation-action').waitFor({state:'hidden',timeout:2000});
 await page.locator('.html-brief-frame').evaluate((el,quote)=>{
  const d=el.contentDocument,n=[...d.querySelectorAll('.takeaway')].find(p=>p.textContent.includes(quote)).firstChild,r=d.createRange();
  r.setStart(n,0);r.setEnd(n,quote.length);el.contentWindow.getSelection().addRange(r);
  n.parentElement.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'ArrowRight',shiftKey:true}));
 },quote);
 await frame.locator('.annotation-action').waitFor({state:'visible',timeout:2000});
 // Selection stays usable across scrolling, rather than disappearing until blur.
 await page.locator('main').evaluate(el=>el.scrollTop+=20);
 await frame.locator('.annotation-action').waitFor({state:'visible',timeout:2000});
 const actionBox=await frame.locator('.annotation-action').boundingBox();
 await page.mouse.click(actionBox.x+actionBox.width/2,actionBox.y+actionBox.height/2);await page.locator('.annotation-form textarea').fill('HTMLでも注釈');await page.locator('.annotation-form').getByRole('button',{name:'Save',exact:true}).click();
 assert.equal(await frame.locator('.annotation-mark').innerText(),quote);
 const sent=page.waitForResponse(r=>r.url().endsWith('/feedback')&&r.request().method()==='POST');await page.locator('.conversation-form').getByRole('button',{name:'Comment',exact:true}).click();const response=await sent;assert.equal(response.status(),201);
 const event=(await response.json()).feedback;assert.equal(event.annotations[0].anchor.start,canonical.indexOf(quote));
 await page.reload();await frame.locator('.annotation-mark').waitFor();await frame.locator('.annotation-mark').click();await page.locator('.annotation-preview').waitFor();assert.match(await page.locator('.annotation-preview').innerText(),/HTMLでも注釈/);
 await page.setViewportSize({width:390,height:844});await page.locator('.html-brief-frame').evaluate(el=>{if(el.contentDocument.body.scrollWidth>el.clientWidth+1)throw new Error('HTML overflow');});await page.locator('.html-brief-frame').evaluate(el=>{const main=el.closest('main');main.scrollTop=el.offsetTop-10;});await page.screenshot({path:'/tmp/chill-html-brief-mobile.png',fullPage:true});
 await frame.getByText('PlanとHistoryの居場所',{exact:true}).click();assert.equal(await frame.locator('details[open]').count(),1);
 await page.goto(url+'/#/goal/1/v1');await page.getByRole('heading',{name:'Markdown remains'}).waitFor();assert.equal(await page.locator('.html-brief-frame').count(),0);assert.match(await page.locator('.brief-body').innerText(),/Markdown remains/);
 // The same action returns to the parent document with its handlers intact.
 await page.locator('.brief-body p').evaluate(el=>{const r=document.createRange();r.selectNodeContents(el);const s=window.getSelection();s.removeAllRanges();s.addRange(r);document.dispatchEvent(new Event('selectionchange'));});
 await page.getByRole('button',{name:'Annotate selected text',exact:true}).click();
 await page.locator('.annotation-form').waitFor({state:'visible'});
 await page.getByRole('button',{name:'Close annotation',exact:true}).click();
 await run('brief','update','--id','1','--format','markdown');await page.goto(url+'/#/goal/1');await page.getByRole('heading',{name:'Markdown remains'}).waitFor();assert.equal(await page.locator('.html-brief-frame').count(),0);
 assert.deepEqual(errors,[]);console.log('passed: isolated HTML, annotation with delayed selectionchange, scroll positioning, canonical annotations, saved note preview, responsive layout, disclosures and mixed-format history');
} finally {await browser?.close();if(server.exitCode===null){server.kill();await once(server,'exit');}await rm(root,{recursive:true,force:true});}
