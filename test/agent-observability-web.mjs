// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/agent-observability-web.mjs
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {promisify} from 'node:util';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=await mkdtemp(join(tmpdir(),'chill-observability-'));
const env={...process.env,CHILL_AGENT_DATA_DIR:root,CODEX_HOME:root,PORT:'0',CHILL_AGENT_EXTENSIONS:'none',CHILL_AGENT_CODEX_PATH:new URL('./fake-codex.mjs',import.meta.url).pathname};
const cli=new URL('../bin/chill-agent.mjs',import.meta.url).pathname,exec=promisify(execFile);
let server,browser,page;
try{
 await exec(process.execPath,[cli,'create','--title','A calm workspace','--thread-id','00000000-0000-0000-0000-000000000001'],{env});
 await exec(process.execPath,[cli,'create','--title','Another workspace'],{env});
 server=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname,'--local'],{env,stdio:['ignore','pipe','pipe']});
 const url=await new Promise((resolve,reject)=>{server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});server.on('error',reject);server.on('exit',c=>reject(Error(`Server exit ${c}`)));});
 browser=await chromium.launch({headless:true});page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let status='idle',fail=false,extFail=false,delay=0,agentReads=0,enabled=false,posts=0,queued=false;
 const message='Every Goal is marked Done. Check for anything missed.\n\n1. Read the index.\n2. Continue agreed work.\n\n<not-html>\n'+'chill goal review --id 1\n'.repeat(16);
 const activity={label:'AutoContinue',status:'Off',total:2,entries:[{id:'latest',at:'2026-10-05T00:10:00Z',summary:'Check for anything missed in the completed Goals.',message,result:{label:'No work reported',at:'2026-10-05T00:11:00Z'}},{id:'old',at:'2026-10-04T23:10:00Z',summary:'Automatic check',message:null,status:'Run ended'}]};
 await page.route('**/api/goals/*/agent/presence',async route=>{
  const requested=status,pause=delay;await new Promise(r=>setTimeout(r,pause));
  await route.fulfill({status:fail?503:200,json:{connected:true,status:requested}}).catch(()=>{});
 });
 await page.route('**/api/goals/*/agent',async route=>{agentReads++;await route.fulfill({json:{connected:true,work:{status},settings:{model:'astra',label:'GPT-6 Astra',reasoning:'xhigh'},models:[{id:'astra',label:'GPT-6 Astra',efforts:['high','xhigh']}],capabilities:{settings:true},usage:[{name:'codex',windows:[{minutes:10080,remaining:55,resetAt:1791590400}]}],queue:{items:queued?[{goalId:'2',title:'A queued request'}]:[]}}});});
 await page.route(/\/api\/goals\/\d+\/extensions(?:\/[^?]+)?(?:\?.*)?$/,async route=>{
  if(route.request().method()==='POST'){posts++;enabled=route.request().postDataJSON().enabled;}
  const detailed=new URL(route.request().url()).searchParams.get('activity')==='1';
  await route.fulfill({status:extFail?503:200,json:extFail?{error:'Unavailable'}:[{id:'continuation',rootId:'1',label:'Auto-continue',enabled,placement:'header',icon:'repeat',...(detailed?{activity}:{})}]});
 });
 for(const width of [1400,390,320]){
  await page.setViewportSize({width,height:844});const before=agentReads;await page.goto(`${url}/#/goal/1`);
  await page.waitForFunction(()=>document.querySelector('#agent-button').dataset.state==='idle');assert.equal(agentReads,before,'closed header must not read settings/usage');
  const button=page.getByRole('button',{name:'Agent',exact:true});await button.hover();await page.locator('#agent-tooltip').waitFor({state:'visible'});assert.match(await page.locator('#agent-tooltip').innerText(),/Agent · Idle/);
  await button.click();await page.locator('.agent-auto > summary').waitFor();
  assert.deepEqual((await page.locator('.agent-overview .agent-row-label').allTextContents()),['Activity','Queue','AutoContinue']);
  assert.equal(await page.locator('.agent-auto').getAttribute('open'),null);assert.equal(await page.locator('.agent-auto-entry').first().isVisible(),false);
  assert.equal(await page.locator('.agent-usage').getAttribute('open'),null);
  assert.equal(await page.getByLabel('Model',{exact:true}).isVisible(),true);
  await page.screenshot({path:`/tmp/chill-384-compact-${width}.png`});
  const panel=page.locator('#agent-panel'),box=await panel.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width);assert.ok(box.y+box.height<=844);assert.ok(box.height<350,'secondary controls stay compact when closed');
  assert.equal(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  await page.locator('.agent-auto > summary').focus();await page.keyboard.press('Enter');
  await page.getByText('View message',{exact:true}).click();assert.equal(await page.locator('.agent-auto-message').textContent(),message);assert.equal(await page.locator('not-html').count(),0);
  await page.getByText('History 1',{exact:true}).click();await page.getByText('Message not saved.',{exact:true}).waitFor();
  await page.locator('[data-agent-refresh]').click();await page.waitForTimeout(100);
  assert.equal(await page.locator('details[data-agent-detail][open]').count(),3,'poll refresh keeps disclosures open');
  await page.screenshot({path:`/tmp/chill-384-expanded-${width}.png`});
  await page.keyboard.press('Escape');assert.equal(await button.evaluate(el=>el===document.activeElement),true);
 }
 queued=true;await page.goto(`${url}/#/goal/1`);await page.getByRole('button',{name:'Agent',exact:true}).click();
 await page.getByText('1 waiting',{exact:true}).waitFor();assert.equal(await page.getByText('#2 A queued request',{exact:true}).isVisible(),false);
 await page.locator('[data-agent-detail="queue"] > summary').click();await page.getByText('#2 A queued request',{exact:true}).waitFor();
 await page.locator('.agent-usage > summary').click();await page.locator('.agent-window progress').waitFor();
 await page.locator('[data-agent-refresh]').click();await page.waitForTimeout(100);assert.equal(await page.locator('[data-agent-detail="queue"]').getAttribute('open'),'');assert.equal(await page.locator('.agent-usage').getAttribute('open'),'');
 await page.keyboard.press('Escape');queued=false;
 for(const state of ['working','paused','idle']){
  status=state;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForFunction(s=>document.querySelector('#agent-button').dataset.state===s,state);
  await page.screenshot({path:`/tmp/chill-381-${state}.png`});
 }
 fail=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForFunction(()=>document.querySelector('#agent-button').dataset.state==='unknown');fail=false;
 // A late response from another Goal must not repaint this Goal's badge.
 status='working';delay=400;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForTimeout(30);
 status='paused';delay=0;await page.goto(`${url}/#/goal/2`);await page.waitForFunction(()=>document.querySelector('#agent-button').dataset.state==='paused');await page.waitForTimeout(500);assert.equal(await page.locator('#agent-button').getAttribute('data-state'),'paused');
 extFail=true;await page.getByRole('button',{name:'Agent',exact:true}).click();await page.locator('.agent-overview-row').filter({hasText:'Extensions'}).filter({hasText:'Unavailable'}).waitFor();await page.getByText('Activity',{exact:true}).waitFor();await page.keyboard.press('Escape');extFail=false;
 await page.goto(`${url}/#/goal/1`);const toggle=page.getByRole('button',{name:'Auto-continue',exact:true});await toggle.waitFor();await toggle.click();await page.waitForFunction(()=>document.querySelector('[data-header-extension]').getAttribute('aria-pressed')==='true');assert.equal(posts,1);
 await page.goto(`${url}/#/goals`);await page.locator('#agent-button').waitFor({state:'hidden'});assert.deepEqual(errors,[]);
 console.log('passed: ordered sections, exact escaped messages/history, preserved disclosures, responsive layout, closed-menu presence, status transitions/failure/stale routes, keyboard close, isolated extension failure, one-click toggle');
}catch(error){if(page){console.error(await page.locator('body').innerText());await page.screenshot({path:'/tmp/chill-381-test-failure.png'});}throw error;}finally{await browser?.close();if(server&&server.exitCode===null){server.kill();await once(server,'exit');}await rm(root,{recursive:true,force:true});}
