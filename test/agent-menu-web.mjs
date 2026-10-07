// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/agent-menu-web.mjs
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {promisify} from 'node:util';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=await mkdtemp(join(tmpdir(),'chill-agent-menu-'));
const env={...process.env,CHILL_AGENT_DATA_DIR:root,CODEX_HOME:root,PORT:'0',CHILL_AGENT_CODEX_PATH:new URL('./fake-codex.mjs',import.meta.url).pathname};
const cli=new URL('../bin/chill-agent.mjs',import.meta.url).pathname,exec=promisify(execFile);
const run=async(...args)=>JSON.parse((await exec(process.execPath,[cli,...args],{env})).stdout);
let server,browser;
try {
 await run('create','--title','Root','--thread-id','00000000-0000-0000-0000-000000000001');await run('create','--title','Child','--parent','1');await run('create','--title','Unassigned');
 const brief=await run('brief','path','--id','1','--format','html');await writeFile(brief.path,'<style>body{height:950px;padding:25px}</style><h1>Brief test</h1><p>Click outside the Agent menu here.</p>');await run('brief','update','--id','1','--format','html');
 server=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname,'--local'],{env,stdio:['ignore','pipe','pipe']});
 const url=await new Promise((resolve,reject)=>{server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});server.on('error',reject);server.on('exit',c=>reject(new Error(`Server exit ${c}`)));});
 browser=await chromium.launch({headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));let reads=0;page.on('request',r=>{if(/\/agent$/.test(r.url()))reads++;});
 for(const width of [1400,390,320]){
  await page.setViewportSize({width,height:844});await page.goto('about:blank');const before=reads;await page.goto(`${url}/#/goal/1`);
  const button=page.getByRole('button',{name:'Agent',exact:true});await button.waitFor();assert.equal(reads,before,'No agent polling while closed');
  const textarea=page.locator('.conversation-form textarea').first();await textarea.fill('Keep this draft');await page.locator('main').evaluate(el=>el.scrollTop=400);const scroll=await page.locator('main').evaluate(el=>el.scrollTop);
  await button.click();await page.getByText('GPT-6 Astra',{exact:true}).waitFor();await page.getByText('88% left',{exact:true}).waitFor();
  const panel=page.locator('#agent-panel'),box=await panel.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width);assert.ok(box.y+box.height<=844);assert.equal(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  assert.equal(await page.locator('main').evaluate(el=>el.scrollTop),scroll);await page.keyboard.press('Escape');assert.equal(await panel.isVisible(),false);assert.equal(await button.evaluate(el=>el===document.activeElement),true);assert.equal(await textarea.inputValue(),'Keep this draft');
  await button.click();await page.getByText('GPT-6 Astra',{exact:true}).waitFor();await page.getByRole('button',{name:'Close'}).click();assert.equal(await panel.isVisible(),false);
  await page.locator('main').evaluate(el=>el.scrollTop=0);await button.click();await page.getByText('GPT-6 Astra',{exact:true}).waitFor();
  if(width>600)await page.locator('.html-brief-frame').contentFrame().getByText('Click outside the Agent menu here.').click({position:{x:5,y:5}});
  else await page.mouse.click(4,90);
  await panel.waitFor({state:'hidden'});
 }
 await page.goto(`${url}/#/goal/2`);
 const toggle=page.locator('[data-header-extension]');await toggle.waitFor();assert.equal(await toggle.getAttribute('aria-pressed'),'false');
 await page.screenshot({path:'/tmp/chill-extension-off.png'});
 await toggle.click();await page.getByRole('switch',{name:'Auto-continue'}).click();await page.waitForFunction(()=>document.querySelector('[data-header-extension]')?.getAttribute('aria-pressed')==='true');
 assert.equal((await (await fetch(url+'/api/goals/1/extensions')).json())[0].enabled,true);
 await page.keyboard.press('Escape');await toggle.hover();await page.getByRole('tooltip').waitFor({state:'visible'});assert.match(await page.getByRole('tooltip').innerText(),/Prompts the agent to keep going/);await page.screenshot({path:'/tmp/chill-extension-on.png'});
 const box=await toggle.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=320);
 await page.goto(`${url}/#/goal/1`);await toggle.waitFor();assert.equal(await toggle.getAttribute('aria-pressed'),'true');
 await toggle.click();await page.getByRole('switch',{name:'Auto-continue'}).click();await page.waitForFunction(()=>document.querySelector('[data-header-extension]')?.getAttribute('aria-pressed')==='false');
 assert.equal((await (await fetch(url+'/api/goals/2/extensions')).json())[0].enabled,false);
 await page.getByRole('button',{name:'Agent',exact:true}).click();await page.getByText('GPT-6 Astra',{exact:true}).waitFor();assert.equal(await page.locator('#agent-panel [data-extension]').count(),0);
 const menuToggle=page.locator('[data-agent-extension]');await menuToggle.waitFor();
 const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/extensions/'));
 await menuToggle.click();const changed=await (await response).json();assert.ok(changed[0].activity,'menu saves return activity snapshots');
 await page.waitForFunction(()=>document.querySelector('[data-header-extension]').getAttribute('aria-pressed')==='true');
 assert.equal(await page.getByRole('heading',{name:'AutoContinue',exact:true}).isVisible(),true);
 await menuToggle.click();await page.waitForFunction(()=>document.querySelector('[data-header-extension]').getAttribute('aria-pressed')==='false');
 assert.equal((await (await fetch(url+'/api/goals/2/extensions')).json())[0].enabled,false);

 await page.goto(`${url}/#/goal/3`);await toggle.waitFor({state:'hidden'});assert.equal(await toggle.count(),0);
 let saved=null,posts=0,failSave=false;
 const editable={connected:true,threadId:'test-thread',settings:{model:'a',label:'A',reasoning:'low'},capabilities:{settings:true},models:[{id:'a',label:'A',efforts:['low','high'],defaultEffort:'low'},{id:'b',label:'B',efforts:['high'],defaultEffort:'high'}],usage:[],queue:{items:[]}};
 await page.route('**/api/goals/1/agent',async route=>{if(route.request().method()==='POST'){posts++;saved=route.request().postDataJSON();if(failSave)return route.fulfill({status:409,json:{error:'Settings changed.'}});await new Promise(r=>setTimeout(r,100));editable.settings={model:saved.model,label:saved.model.toUpperCase(),reasoning:saved.effort};}await route.fulfill({json:editable});});
 await page.goto(`${url}/#/goal/1`);await page.getByRole('button',{name:'Agent',exact:true}).click();
 await page.getByLabel('Model',{exact:true}).waitFor();await page.getByLabel('Model',{exact:true}).selectOption('b');assert.equal(await page.getByLabel('Reasoning',{exact:true}).inputValue(),'high');
 assert.equal(await page.getByRole('button',{name:'Save',exact:true}).count(),0);await page.getByText('Saved',{exact:true}).waitFor();
 assert.deepEqual(saved,{threadId:'test-thread',model:'b',effort:'high',expected:{model:'a',effort:'low'}});assert.equal(posts,1);
 await page.getByLabel('Model',{exact:true}).selectOption('a');await page.getByText('Saved',{exact:true}).waitFor();
 await page.getByLabel('Reasoning',{exact:true}).selectOption('low');await page.getByText('Saved',{exact:true}).waitFor();
 assert.deepEqual(saved,{threadId:'test-thread',model:'a',effort:'low',expected:{model:'a',effort:'high'}});assert.equal(posts,3);
 failSave=true;await page.getByLabel('Reasoning',{exact:true}).selectOption('high');await page.getByText('Settings changed.',{exact:true}).waitFor();assert.equal(await page.getByLabel('Reasoning',{exact:true}).inputValue(),'low');assert.equal(posts,4);
 failSave=false;await page.getByLabel('Reasoning',{exact:true}).selectOption('high');await page.keyboard.press('Escape');await page.getByRole('button',{name:'Agent',exact:true}).click();await page.getByLabel('Reasoning',{exact:true}).waitFor();assert.equal(await page.getByLabel('Reasoning',{exact:true}).inputValue(),'high');assert.equal(posts,5);


 await page.keyboard.press('Escape');await page.unroute('**/api/goals/1/agent');
 await page.route('**/api/goals/2/agent',async route=>{await new Promise(r=>setTimeout(r,400));await route.fulfill({json:{connected:true,rootTitle:'STALE OWNER',settings:{label:'STALE MODEL'},usage:[],queue:{items:[]}}}).catch(()=>{});});
 await page.goto(`${url}/#/goal/2`);await page.getByRole('button',{name:'Agent',exact:true}).click();await page.getByText('Loading…').waitFor();
 await page.goto(`${url}/#/goal/3`);await page.getByRole('button',{name:'Agent',exact:true}).click();await page.getByText('No agent connected.').waitFor();await page.waitForTimeout(500);assert.doesNotMatch(await page.locator('#agent-content').innerText(),/STALE/);
 await page.goto(`${url}/#/goals`);await page.locator('#agent-button').waitFor({state:'hidden'});assert.equal(await page.locator('#agent-button').isVisible(),false);assert.equal(await page.locator('#agent-panel').isVisible(),false);
 await page.goto(`${url}/#/goal/1`);await page.getByRole('button',{name:'Agent',exact:true}).click();await page.getByText('GPT-6 Astra',{exact:true}).waitFor();await page.screenshot({path:'/tmp/chill-agent-menu.png'});assert.deepEqual(errors,[]);
 console.log('passed: icon-only entry, on-demand reads, settings and usage, responsive overflow, Escape/close/iframe outside click, draft and scroll retention, stale route isolation and unassigned Goals');
}finally{await browser?.close();if(server&&server.exitCode===null){server.kill();await once(server,'exit');}await rm(root,{recursive:true,force:true});}
