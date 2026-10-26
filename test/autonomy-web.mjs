// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/autonomy-web.mjs
// The comment box's Autonomy dropdown: name only, a panel that fits a phone,
// a choice that saves for the whole tree, and a failed save that changes nothing.
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
// The conversation column scrolls by itself; the panel must not be clipped by it.
const unclipped=panel=>panel.evaluate(p=>{const r=p.getBoundingClientRect();return [[r.left+12,r.top+12],[r.right-12,r.bottom-12]].every(([x,y])=>p.contains(document.elementFromPoint(x,y)));});
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=await mkdtemp(join(tmpdir(),'chill-autonomy-web-'));let server,browser;
const env={...process.env,CHILL_AGENT_DATA_DIR:root,CODEX_HOME:root,PORT:'0',CHILL_AGENT_EXTENSIONS:'none'};
const cli=(...args)=>promisify(execFile)(process.execPath,[new URL('../bin/chill-agent.mjs',import.meta.url).pathname,...args],{env});
try{
 await cli('create','--title','A calmer workspace');await cli('create','--title','Quieter buttons','--parent','1');
 server=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname,'--local'],{env,stdio:['ignore','pipe','pipe']});
 const url=await new Promise((resolve,reject)=>{server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});server.on('error',reject);server.on('exit',c=>reject(Error(`Server exit ${c}`)));});
 browser=await chromium.launch();const page=await browser.newPage({viewport:{width:375,height:812}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const trigger=page.locator('[data-autonomy-button]'),panel=page.getByRole('dialog',{name:'Autonomy'});
 await page.goto(url+'/#/goal/1');await trigger.waitFor();
 assert.equal(await trigger.getAttribute('aria-label'),'Autonomy: Normal');assert.equal(await trigger.getAttribute('aria-expanded'),'false');
 assert.equal(await page.locator('.autonomy input,.autonomy-range,.autonomy-tip').count(),0,'no slider is left');
 await trigger.click();await panel.waitFor();
 assert.equal(await trigger.getAttribute('aria-expanded'),'true');
 assert.deepEqual(await panel.locator('[data-autonomy-level] b').allTextContents(),['Normal','Auto Continue','Ultra Continue']);
 assert.deepEqual(await panel.locator('[data-autonomy-level]').evaluateAll(b=>b.map(x=>x.getAttribute('aria-pressed'))),['true','false','false']);
 assert.match(await panel.innerText(),/^Autonomy\n[\s\S]*For the agent on this Root\.$/);
 assert.doesNotMatch(await page.locator('.autonomy').innerText(),/Lv|\d/,'no level numbers are shown');
 const box=await panel.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=375&&box.y>=0&&box.y+box.height<=812,`the panel stays on a phone screen: ${JSON.stringify(box)}`);assert.ok(await unclipped(panel),'the panel shows whole on a phone');
 assert.equal(await page.evaluate(()=>document.activeElement.dataset.autonomyLevel),'1','the current level has focus');
 await page.keyboard.press('Escape');await panel.waitFor({state:'hidden'});
 assert.equal(await page.evaluate(()=>document.activeElement.hasAttribute('data-autonomy-button')),true,'Escape gives focus back to the button');
 await trigger.click();await page.locator('#goal-title').click();await panel.waitFor({state:'hidden'});
 // A failed save leaves the level as it was and says so.
 await page.route('**/api/goals/1/autonomy',r=>r.fulfill({status:500,contentType:'application/json',body:'{"error":"boom"}'}));
 await trigger.click();await panel.getByRole('button',{name:/^Ultra Continue/}).click();
 await panel.getByText('Could not save. Autonomy is unchanged.',{exact:true}).waitFor();
 assert.equal(await trigger.getAttribute('aria-label'),'Autonomy: Normal');
 await page.unroute('**/api/goals/1/autonomy');
 await panel.getByRole('button',{name:/^Ultra Continue/}).click();await panel.waitFor({state:'hidden'});
 assert.equal(await trigger.getAttribute('aria-label'),'Autonomy: Ultra Continue');assert.match(await trigger.innerText(),/Ultra Continue/);
 assert.equal(await page.evaluate(()=>document.activeElement.hasAttribute('data-autonomy-button')),true,'focus returns to the button after saving');
 const saved=await (await fetch(url+'/api/goals?view=web')).json();
 assert.deepEqual((saved.goals||saved).map(g=>[g.id,g.autonomy]),[['1',3],['2',3]],'the Root agent\'s level, shown on every Goal');
 await page.goto(url+'/#/goal/2');await page.locator('[data-autonomy-button][aria-label="Autonomy: Ultra Continue"]').waitFor();
 await page.setViewportSize({width:1280,height:900});await trigger.click();await panel.waitFor();
 const wide=await panel.boundingBox(),button=await trigger.boundingBox();assert.ok(wide.y+wide.height<=button.y+2||wide.y>=button.y+button.height-2,'the panel opens next to the button');
 assert.ok(await unclipped(panel),'the panel shows whole beside the conversation column');
 assert.deepEqual(errors,[]);
 console.log('Autonomy dropdown checks passed.');
}finally{await browser?.close();server?.kill();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
