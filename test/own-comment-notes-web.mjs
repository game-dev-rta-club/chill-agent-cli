import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {promisify} from 'node:util';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
// A note on the user's own comment, written with the same "/" skill completion as a comment.
const root=await mkdtemp(join(tmpdir(),'chill-own-comment-notes-')),home=join(root,'home');
for(const name of ['grilling','grill-plan','grill-ui','grill-copy','grill-tests','grill-data']){await mkdir(join(home,'.claude','skills',name),{recursive:true});await writeFile(join(home,'.claude','skills',name,'SKILL.md'),`---\nname: ${name}\ndescription: Ask hard questions\n---\n`);}
const env={...process.env,CHILL_AGENT_DATA_DIR:root,PORT:'0',HOME:home};
const execute=promisify(execFile),cli=new URL('../bin/chill-agent.mjs',import.meta.url).pathname;
await execute(process.execPath,[cli,'create','--title','Own comment notes'],{env});
const server=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname,'--local'],{env,stdio:['ignore','pipe','pipe']});
const url=await new Promise(resolve=>server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);}));
let browser;
try{
 const own=(await(await fetch(url+'/api/goals/1/feedback',{method:'POST',headers:{'Content-Type':'application/json',Origin:url},body:JSON.stringify({text:'My own first thought'})})).json()).feedback;
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1056,height:900}}),errors=[];
 page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(url+'/#/goal/1');
 const text=page.locator(`[data-annotation-reply="${own.id}"] p`);await text.waitFor();
 await text.evaluate(el=>{const r=document.createRange();r.setStart(el.firstChild,3);r.setEnd(el.firstChild,6);const s=window.getSelection();s.removeAllRanges();s.addRange(r);document.dispatchEvent(new Event('selectionchange'));});
 await page.getByRole('button',{name:'Annotate selected text',exact:true}).click();
 const form=page.locator('.annotation-form');await form.waitFor({state:'visible'});
 assert.match(await form.locator('.annotation-quote').innerText(),new RegExp(`Comment ${own.id} · own`));
 const field=form.locator('textarea[data-input="annotation"]');
 await field.click();await field.pressSequentially('Try /gri');
 const menu=form.locator('.skill-menu');await menu.getByText('/grilling').waitFor();
 await page.screenshot({path:'/tmp/chill-own-comment-skill-menu.png'});
 // The list sits inside the note box, not cut off by its scrolling.
 assert.ok(await menu.evaluate(el=>{const m=el.getBoundingClientRect(),f=el.closest('.annotation-form').getBoundingClientRect();return m.top>=f.top&&m.bottom<=f.bottom;}));
 // Escape closes only the menu; the note stays open.
 await field.press('Escape');assert.equal(await menu.count(),0);assert.ok(await form.isVisible());
 await field.pressSequentially('lli');await menu.getByText('/grilling').waitFor();await field.press('Enter');
 assert.equal(await field.inputValue(),'Try /grilling ');assert.ok(await form.isVisible());
 await form.getByRole('button',{name:'Save',exact:true}).click();await form.waitFor({state:'hidden'});
 const response=page.waitForResponse(r=>r.url().endsWith('/feedback')&&r.request().method()==='POST');
 await page.locator('.conversation-form').getByRole('button',{name:'Comment',exact:true}).click();
 const note=(await(await response).json()).feedback.annotations[0];
 assert.deepEqual([note.source,note.anchor.quote,note.text],[{kind:'comment',eventId:own.id},'own','Try /grilling']);
 await page.locator(`[data-annotation-reply="${own.id}"] .annotation-mark`).first().waitFor();
 assert.deepEqual(errors,[]);
 await page.screenshot({path:'/tmp/chill-own-comment-notes.png'});
}finally{await browser?.close();server.kill();await once(server,'exit');await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
console.log('own comment notes web test passed');
