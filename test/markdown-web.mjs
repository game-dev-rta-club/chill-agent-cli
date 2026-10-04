// Optional browser trial: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node test/markdown-web.mjs
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {markdownText} from '../lib/markdown.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=await mkdtemp(join(tmpdir(),'chill-markdown-web-')),env={...process.env,CHILL_AGENT_DATA_DIR:root,PORT:'0'};
const execute=promisify(execFile),cli=new URL('../bin/chill-agent.mjs',import.meta.url).pathname;
const run=async(...args)=>JSON.parse((await execute(process.execPath,[cli,...args],{env})).stdout);
await run('create','--title','Brief and Markdown');
const source='# What we will realize\n\nA short **shared outcome**.\n\n## Behavior\n\n- First option\n- Second option\n\n### Details\n\n| Item | Status |\n| --- | --- |\n| Table value | Ready |\n\n```mermaid\ngraph LR\n A[Question] --> B[Answer]\n```\n\nParagraph **after diagram**.\n\n## Other\n\n```js\nconst html = "<button>";\n```';
await writeFile(join(root,'workspace/goals/1/brief.md'),source);await run('brief','update','--id','1');
const message='**Formatted** opening.\n\n## Supporting information\n\n### Table\n\n| Item | State |\n| --- | --- |\n| Choice | Ready |\n\n```mermaid\ngraph TD\n A --> B\n```\n\nUse [the guide](https://example.com) after this diagram.';
const comment=await run('letter','--id','1','--title','Can you read this Letter?','--text',message);
const server=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname,'--local'],{env,stdio:['ignore','pipe','pipe']});
const url=await new Promise((resolve,reject)=>{server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});server.on('error',reject);server.on('exit',code=>reject(new Error(`Server exit ${code}`)));});
let browser;
try {
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1000,height:850}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(url+'/#/goal/1');await page.locator('.conversation-form').waitFor();
 const brief=page.locator('.brief-body'),card=page.locator(`#event-${comment.id}`);
 assert.equal(await brief.locator('details[open]').count(),0);assert.equal(await brief.locator('details').count(),3);
 assert.equal(await brief.locator('strong').first().innerText(),'shared outcome');assert.equal(await card.locator('.event-text strong').innerText(),'Formatted');
 assert.equal(await brief.locator('table').isVisible(),false);
 await brief.getByText('Behavior',{exact:true}).click();assert.equal(await brief.locator('li').count(),2);assert.equal(await brief.locator('table').isVisible(),false);
 await brief.getByText('Details',{exact:true}).click();await brief.locator('.mermaid-diagram svg').waitFor();
 assert.equal(await brief.locator('td').first().innerText(),'Table value');assert.equal(await brief.locator('details[open]').count(),2);
 assert.equal(await brief.evaluate(el=>[...el.querySelectorAll('style')].every(s=>s.nonce===document.querySelector('meta[name="style-nonce"]').content)),true);
 await card.getByText('Supporting information',{exact:true}).click();await card.getByText('Table',{exact:true}).click();await card.locator('.mermaid-diagram svg').waitFor();
 const {annotationTextNodes}=await import('../public/markdown-view.js'); // Browser-independent module import is harmless.
 assert.equal(typeof annotationTextNodes,'function');
 const canonical=await page.evaluate(async()=>{
  const {annotationTextNodes}=await import('/markdown-view.js');return annotationTextNodes(document.querySelector('.brief-body')).map(n=>n.textContent).join('');
 });assert.equal(canonical,markdownText(source));
 async function annotate(selector,quote,reply) {
  await page.locator(selector).scrollIntoViewIfNeeded();
  await page.evaluate(({selector,quote})=>{const el=document.querySelector(selector),node=el.firstChild;const r=document.createRange();r.setStart(node,node.textContent.indexOf(quote));r.setEnd(node,node.textContent.indexOf(quote)+quote.length);const s=window.getSelection();s.removeAllRanges();s.addRange(r);document.dispatchEvent(new Event('selectionchange'));},{selector,quote});
  await page.locator('.annotation-action').click();await page.locator('.annotation-form textarea').fill(reply);
  await page.locator('.annotation-form').getByRole('button',{name:'Save',exact:true}).click();
 }
 await annotate('.brief-body .detail-content p strong','after diagram','Brief after a diagram');
 await annotate(`#event-${comment.id} .event-text a`,'the guide','Letter formatted link');
 const sent=page.waitForResponse(r=>r.url().endsWith('/feedback')&&r.request().method()==='POST');
 await page.locator('.conversation-form').getByRole('button',{name:'Comment',exact:true}).click();const result=await sent;assert.equal(result.status(),201);const event=(await result.json()).feedback;
 assert.equal(event.annotations.length,2);assert.equal(event.annotations[0].anchor.start,markdownText(source).indexOf('after diagram'));
 assert.equal(event.annotations[1].anchor.start,markdownText(message).indexOf('the guide'));
 await page.reload();await page.locator('.conversation-form').waitFor();
 assert.equal(await brief.locator('details[open]').count(),0);assert.equal(await brief.locator('.annotation-mark').count(),1);
 // Selecting the saved annotation opens both ancestors and remains positioned.
 await page.locator(`#event-${event.id} [data-action="locate-note"]`).first().click();
 await brief.locator('.annotation-mark').waitFor();assert.equal(await brief.locator('.annotation-mark').isVisible(),true);
 await brief.locator('.mermaid-diagram svg').waitFor();
 const diagramBox=await brief.locator('.mermaid-diagram svg').boundingBox();assert.ok(diagramBox.height>30 && diagramBox.width>30,JSON.stringify(diagramBox));
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/chill-brief-mobile.png'});
 assert.equal(await page.evaluate(()=>document.querySelector('.brief-body').scrollWidth<=document.querySelector('.brief-body').clientWidth+1),true);
 await page.setViewportSize({width:1000,height:850});await page.screenshot({path:'/tmp/chill-brief-desktop.png'});
 // Invalid Mermaid keeps its source readable without breaking the page.
 await run('comment','--id','1','--text','```mermaid\nnot a diagram\n```');await page.reload();await page.locator('.mermaid-diagram[data-rendered="error"]').waitFor();
 assert.deepEqual(errors,[]);console.log('passed: nested folds, tables, Mermaid, canonical annotations, saved references, mobile layout, invalid diagram fallback');
} finally {await browser?.close();if(server.exitCode===null){server.kill();await once(server,'exit');}await rm(root,{recursive:true,force:true});}
