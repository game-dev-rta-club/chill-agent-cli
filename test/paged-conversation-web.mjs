// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/paged-conversation-web.mjs
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {promisify} from 'node:util';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=await mkdtemp(join(tmpdir(),'chill-paged-web-'));
const env={...process.env,CHILL_AGENT_DATA_DIR:root,CHILL_AGENT_STORAGE:'sqlite',PORT:'0'},execute=promisify(execFile);
let browser,server;
try{
 const store=new URL('../lib/goal-store.mjs',import.meta.url).href;
 await execute(process.execPath,['--input-type=module','-e',`
 import * as s from ${JSON.stringify(store)};
 await s.createGoal({title:'Paged conversation'});
 const letter=await s.appendAgentComment({goalId:'1',type:'letter',title:'Old closed Letter',text:'Original question'});
 await s.closeLetter('1',letter.id);
 for(let i=0;i<65;i++)await s.appendAgentComment({goalId:'1',type:'comment',text:'Comment '+i});
 `],{env});
 server=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname,'--local'],{env,stdio:['ignore','pipe','pipe']});
 const url=await new Promise((resolve,reject)=>{server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});server.on('error',reject);server.on('exit',code=>reject(Error(`Server exit ${code}`)));});
 browser=await chromium.launch({headless:true});const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 for(const viewport of [{width:1400,height:960},{width:390,height:844}]){
  await page.setViewportSize(viewport);await page.goto(`${url}/#/goal/1/letter/1`);
  await page.locator('#event-1').waitFor();assert.ok((await page.locator('#event-1').innerText()).includes('Original question'));
  const older=page.locator('[data-action="load-older-conversation"]');await older.click();await older.waitFor({state:'visible'});
  // Wait for the first request to finish before fetching the last page.
  await page.waitForFunction(()=>!document.querySelector('[data-action="load-older-conversation"]')?.disabled);
  await older.click();await older.waitFor({state:'detached'});
  assert.equal(await page.locator('#event-1').count(),1);
  await page.goto('about:blank');
 }
 assert.deepEqual(errors,[]);console.log('passed: paged history and off-page closed Letter links on desktop and mobile');
}finally{await browser?.close();if(server&&server.exitCode===null){server.kill();await once(server,'exit');}await rm(root,{recursive:true,force:true});}
