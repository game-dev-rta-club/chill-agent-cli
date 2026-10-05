// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node test/activity-controls-web.mjs
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const dir=await mkdtemp(join(tmpdir(),'chill-controls-web-'));
process.env.CHILL_AGENT_DATA_DIR=dir;
const {createGoal,appendFeedback,appendAgentComment}=await import('../lib/goal-store.mjs');
await createGoal({title:'Root'});await createGoal({title:'Work target',parentId:'1'});
const a=await appendFeedback({goalId:'1',text:'First request'}),b=await appendFeedback({goalId:'1',text:'Additional request'});
for(let n=0;n<8;n++)await appendAgentComment({goalId:'1',type:'comment',text:'Later discussion '+n});
let browser,server;
try{
 server=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname,'--local'],{env:{...process.env,PORT:'0'},stdio:['ignore','pipe','pipe']});
 const url=await new Promise((resolve,reject)=>{server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});server.on('error',reject);});
 browser=await chromium.launch({headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const work={turnId:'turn',messages:[{id:'m1',text:'Shared execution output',at:1}],status:'working'};
 let run={threadId:'thread',turnId:null,eventId:b.changeId,goalId:'1',targetGoalId:'2',status:'queued',capabilities:{stop:true}},posts=0,fail=false,delay=0;
 await page.route('**/api/goals/1/deliveries',r=>r.fulfill({json:[a,b].map(e=>({eventId:e.changeId,goalId:'1',threadId:'thread',status:'working',work,history:[{status:'working',at:new Date().toISOString()}]}))}));
 await page.route('**/api/goals/*/agent/activity',async r=>{const snapshot=r.request().url().includes('/1/')?structuredClone(run):null;if(delay)await new Promise(resolve=>setTimeout(resolve,delay));await r.fulfill({json:snapshot});});
 await page.route('**/api/goals',async r=>{const response=await r.fetch();const goals=await response.json();goals.find(g=>g.id==='2').execution=run?.status==='paused'?{status:'paused',activity:{goalId:'1',eventId:b.changeId}}:null;await r.fulfill({json:goals});});
 await page.route('**/api/goals/1/agent/control',async r=>{
  posts++;const input=r.request().postDataJSON();assert.equal(input.eventId,b.changeId);assert.equal(input.turnId,run.turnId);assert.ok(input.requestId);
  await new Promise(resolve=>setTimeout(resolve,180));if(fail)return r.fulfill({status:409,json:{error:'Run changed. Refresh to retry.'}});
  run={...run,status:input.action==='stop'?'paused':'working',turnId:input.action==='stop'?run.turnId:'resumed',capabilities:{stop:input.action==='resume',resume:input.action==='stop'}};
  await r.fulfill({json:run});
 });
 // Activity can lag behind delivery refresh by one request. The last feedback
 // still owns the single indicator, merged output, and native stop control.
 const queued=run;run={...run,eventId:a.changeId,turnId:'turn',status:'working'};
 await page.goto(`${url}/#/goal/1`);await page.getByRole('button',{name:'Pause',exact:true}).waitFor();
 assert.equal(await page.locator('.delivery-entry[data-state="working"]').count(),1);
 assert.equal(await page.locator(`#delivery-${b.changeId} [data-activity-control]`).count(),1);
 assert.equal(await page.getByText('Shared execution output',{exact:true}).count(),1);
 run=queued;await page.goto('about:blank');
 for(const width of [1400,390,320]){
  run=queued;await page.goto('about:blank');
  await page.setViewportSize({width,height:850});await page.goto(`${url}/#/goal/1`);
  const stop=page.getByRole('button',{name:'Pause',exact:true});await stop.waitFor();if(width===1400)assert.equal(await page.locator(`#delivery-${b.changeId} .delivery-heading strong`).textContent(),'Queued');assert.equal(await stop.count(),1);assert.equal(await page.getByText('Shared execution output',{exact:true}).count(),1);
  assert.equal(await page.locator(`[data-activity-control]`).count(),1);
  const textarea=page.locator('.conversation-form textarea').first();await textarea.fill('Retained draft');
  await stop.click();await page.getByRole('button',{name:'Resume',exact:true}).waitFor();await page.locator('.status.paused').waitFor();
  assert.equal(await page.getByText('Queue paused.',{exact:true}).count(),1);assert.equal(await textarea.inputValue(),'Retained draft');
  assert.equal(await page.locator(`#delivery-${b.changeId}`).evaluate(e=>e.scrollWidth<=e.clientWidth),true);
  await page.reload();await page.getByRole('button',{name:'Resume',exact:true}).waitFor();
  // Old paused Activity remains visible even with many later comments.
  assert.equal(await page.locator(`#event-${b.changeId}`).count(),1);
  await page.locator('.status.paused').click();await page.waitForURL(`**/activity/${b.changeId}`);await page.getByRole('button',{name:'Resume',exact:true}).waitFor();
  if(width===390)await page.screenshot({path:'/tmp/chill-paused-activity-390.png'});
  await page.getByRole('button',{name:'Resume',exact:true}).click();await stop.waitFor();await page.locator('.status.paused').waitFor({state:'detached'});
 }
 assert.equal(posts,6);
 fail=true;await page.getByRole('button',{name:'Pause',exact:true}).click();await page.getByRole('button',{name:'Refresh',exact:true}).waitFor();assert.equal(posts,7);
 assert.equal(await page.getByRole('button',{name:'Pause',exact:true}).count(),0);
 fail=false;await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:'Pause',exact:true}).waitFor();assert.equal(posts,7,'refresh does not resend');
 delay=500;await page.goto(`${url}/#/goal/1`);await page.locator('.conversation-form').waitFor();await page.evaluate(()=>location.hash='#/goal/2');await page.locator('#goal-title').filter({hasText:'Work target'}).waitFor();await page.waitForTimeout(700);assert.equal(await page.locator('[data-activity-control]').count(),0);
 // A stalled historical-log request must not block discovery of a new run.
 const running={...run};run=null;delay=0;let releaseLogs;
 const heldLogs=new Promise(resolve=>{releaseLogs=resolve;});
 await page.route('**/api/goals/1/deliveries',async r=>{await heldLogs;await r.fulfill({json:[]});});
 await page.goto(`${url}/#/goal/1`);await page.locator('.conversation-form').waitFor();await page.waitForTimeout(5500);
 run=running;await page.getByRole('button',{name:'Pause',exact:true}).waitFor({timeout:5000});
 releaseLogs();
 run={...run,capabilities:{}};delay=0;await page.reload();await page.locator('.conversation-form').waitFor();await page.waitForTimeout(400);assert.equal(await page.locator('[data-activity-control]').count(),0);
 // Saving shows a stop button without waiting for the activity endpoint.
 let savedId,releaseActivity;
 const activityGate=new Promise(resolve=>{releaseActivity=resolve;});
 await page.route('**/api/goals/*/agent/activity',async r=>{await activityGate;await r.fulfill({json:null});});
 await page.route('**/api/goals/1/feedback',async r=>{
  const response=await r.fetch(),result=await response.json();savedId=result.feedback.changeId;
  await r.fulfill({json:{...result,delivery:{eventId:savedId,threadId:'thread',status:'saved'}}});
 });
 await page.goto(`${url}/#/goal/1`);await page.locator('.conversation-form textarea').fill('Pause immediately after save');
 await page.locator('.conversation-form [type=submit]').click();
 await page.getByRole('button',{name:'Pause',exact:true}).waitFor({timeout:2000});
 assert.equal(await page.locator(`#delivery-${savedId} .delivery-heading strong`).textContent(),'Saved');
 assert.equal(await page.locator('[data-activity-control]').count(),1);releaseActivity();
 assert.deepEqual(errors,[]);console.log('passed: shared-turn single control, pause/resume, target Goal badge, reload and fold pinning, paused link, draft retention, desktop/mobile, stale routes, uncertain action refresh without resend, unsupported controls omitted');
}finally{await browser?.close();if(server&&server.exitCode===null){server.kill();await once(server,'exit');}await rm(dir,{recursive:true,force:true});}
