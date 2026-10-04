import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {promisify} from 'node:util';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=await mkdtemp(join(tmpdir(),'chill-brief-updates-')),env={...process.env,CHILL_AGENT_DATA_DIR:root,PORT:'0'};
const execute=promisify(execFile),cli=new URL('../bin/chill-agent.mjs',import.meta.url).pathname;
const run=async(...args)=>JSON.parse((await execute(process.execPath,[cli,...args],{env})).stdout);
await run('create','--title','Auto Brief');
let version=0;
async function publish(format='markdown'){
 version++;const path=await run('brief','path','--id','1','--format',format);
 await writeFile(path.path,format==='html'?`<!doctype html><html><body><h1>Brief ${version}</h1><p>HTML current</p><div style="height:700px"></div></body></html>`:`# Brief ${version}\n\nAnnotation target\n\n${'Long reading paragraph. '.repeat(version===1?150:200)}`);
 await run('brief','update','--id','1','--format',format);
}
await publish();
const server=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname,'--local'],{env,stdio:['ignore','pipe','pipe']});
const url=await new Promise(resolve=>server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);}));
let browser;
try{
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1056,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
 await page.goto(url+'/#/goal/1/v1');await page.getByRole('heading',{name:'Brief 1',exact:true}).waitFor();
 await page.locator('.brief-body p').first().evaluate(el=>{const r=document.createRange();r.selectNodeContents(el);window.getSelection().removeAllRanges();window.getSelection().addRange(r);document.dispatchEvent(new Event('selectionchange'));});
 await page.getByRole('button',{name:'Annotate selected text'}).click();await page.locator('.annotation-form textarea').fill('Keep this annotation');
 await page.locator('.conversation-form textarea').fill('Keep this comment');
 const composer=page.locator('.conversation-form');await composer.scrollIntoViewIfNeeded();
 const oldTop=await composer.evaluate(e=>e.getBoundingClientRect().top-e.closest('main').getBoundingClientRect().top);
 await publish();await page.getByRole('heading',{name:'Brief 2',exact:true}).waitFor();
 await page.locator('#update-notice:not([hidden])').waitFor();assert.match(page.url(),/\/v2$/);
 assert.equal(await page.locator('.conversation-form textarea').inputValue(),'Keep this comment');
 assert.equal(await page.locator('.annotation-form textarea').inputValue(),'Keep this annotation');
 const newTop=await composer.evaluate(e=>e.getBoundingClientRect().top-e.closest('main').getBoundingClientRect().top);assert.ok(Math.abs(newTop-oldTop)<5,`Reading position retained: ${oldTop} -> ${newTop}`);
 await page.locator('.annotation-form').getByRole('button',{name:'Save',exact:true}).click();await page.locator('.annotation-form').waitFor({state:'hidden'});
 const response=page.waitForResponse(r=>r.url().endsWith('/feedback')&&r.request().method()==='POST');
 await composer.getByRole('button',{name:'Comment',exact:true}).click();const saved=await (await response).json();assert.equal(saved.feedback.annotations[0].source.version,1);
 // View brief only scrolls; the latest content was already displayed and the editor survives.
 await page.locator('#view-update').click();await page.locator('#update-notice').waitFor({state:'hidden'});
 assert.match(page.url(),/\/v2$/);assert.ok(await page.locator('.document-heading').evaluate(e=>Math.abs(e.getBoundingClientRect().top-e.closest('main').getBoundingClientRect().top-12)<3));
 await publish('html');await page.frameLocator('.html-brief-frame').getByRole('heading',{name:'Brief 3',exact:true}).waitFor();
 await page.locator('#update-notice:not([hidden])').waitFor();await page.waitForTimeout(5200);assert.equal(await page.locator('#update-notice').isVisible(),true,'Polling does not dismiss');
 await page.mouse.move(600,550);await page.mouse.wheel(0,180);await page.locator('#update-notice').waitFor({state:'hidden'});
 await page.waitForTimeout(5200);assert.equal(await page.locator('#update-notice').isVisible(),false,'Dismissal survives polling');
 // History remains readable while a newer version arrives.
 await page.goto(url+'/#/goal/1/v1');await page.getByRole('heading',{name:'Brief 1',exact:true}).waitFor();await publish();await page.waitForTimeout(5500);
 assert.equal(await page.getByRole('heading',{name:'Brief 1',exact:true}).count(),1);assert.equal(await page.locator('#update-notice').isVisible(),false);
 // Mobile, latest route and keyboard scrolling.
 await page.setViewportSize({width:390,height:844});await page.goto(url+'/#/goal/1');await page.getByRole('heading',{name:'Brief 4',exact:true}).waitFor();
 await publish();await page.getByRole('heading',{name:'Brief 5',exact:true}).waitFor();await page.locator('#update-notice:not([hidden])').waitFor();
 await page.locator('main').focus();await page.keyboard.press('PageDown');await page.locator('#update-notice').waitFor({state:'hidden'});
 assert.deepEqual(errors,[]);console.log('passed: auto-update, retained reading position and drafts, original annotation version, View brief scroll only, wheel/keyboard dismissal, HTML, history, mobile');
}finally{await browser?.close();server.kill();await once(server,'exit');await rm(root,{recursive:true,force:true});}
