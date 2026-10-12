// Build first. PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node test/notifications-web.mjs
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=await mkdtemp(join(tmpdir(),'chill-notifications-web-'));
const runtime=process.env.CHILL_TEST_RUNTIME?pathToFileURL(process.env.CHILL_TEST_RUNTIME+'/'):new URL('../dist/runtime/',import.meta.url),execute=promisify(execFile),thread='00000000-0000-0000-0000-000000000001';
const env={...process.env,CHILL_AGENT_DATA_DIR:root,CODEX_HOME:root,CODEX_THREAD_ID:thread,PORT:'0',CHILL_AGENT_CODEX_PATH:new URL('./fake-codex.mjs',import.meta.url).pathname};
const run=async(file,...args)=>JSON.parse((await execute(process.execPath,[new URL('bin/'+file+'.mjs',runtime).pathname,...args],{env})).stdout);
let server,browser;
try{
 await run('chill-agent','create','--title','Notification preview','--thread-id',thread);
 await run('chill-agent','create','--title','Child','--parent','1');
 await run('chill-agent','create','--title','Other Root','--thread-id',thread);
 server=spawn(process.execPath,[new URL('server.mjs',runtime).pathname,'--local'],{env,stdio:['ignore','pipe','pipe']});
 let output='';server.stderr.on('data',b=>output+=b);
 const url=await new Promise((resolve,reject)=>{server.stdout.on('data',b=>{output+=b;const m=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});server.on('error',reject);server.on('exit',c=>reject(Error(`Server ${c}: ${output}`)));});
 const controls=async id=>(await (await fetch(`${url}/api/goals/${id}/extensions?activity=1`)).json()).find(c=>c.id==='notifications');
 browser=await chromium.launch({headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`${url}/#/goal/2`);await page.getByRole('button',{name:'Agent',exact:true}).click();
 const setup=page.locator('[data-extension-setup="notifications"]');await setup.waitFor();assert.equal(await setup.textContent(),'Set up');
 await setup.click();await page.getByText('Saved in Conversation.',{exact:true}).waitFor();
 await page.locator('[data-agent-close]').click();await page.getByRole('button',{name:'Agent',exact:true}).click();
 await page.getByRole('button',{name:'Requested',exact:true}).waitFor();assert.equal(await setup.isDisabled(),true);
 const event=JSON.parse(await readFile(join(root,'workspace/events/1.json'),'utf8'));assert.match(event.text,/Root Goal #1/);assert.equal(event.author,'user');
 const config=join(root,'profile.json');await writeFile(config,JSON.stringify({enabled:true,tool:'test-reminder',destination:'Private reminders',on:['comment','letter']}));
 await run('chill-settings','notifications','--id','2','--file',config);
 assert.equal((await controls('1')).enabled,true);assert.equal((await controls('3')).enabled,false);
 const go=async()=>{await page.reload();await page.getByRole('button',{name:'Agent',exact:true}).click();await page.locator('[data-agent-extension="notifications"]').waitFor();};
 await go();const toggle=page.locator('[data-agent-extension="notifications"]');assert.equal(await toggle.getAttribute('aria-pressed'),'true');
 await toggle.click();await page.waitForFunction(()=>document.querySelector('[data-agent-extension="notifications"]')?.getAttribute('aria-pressed')==='false');
 const off=await run('chill-settings','show','--id','2');assert.equal(off.notifications.destination,'Private reminders');assert.equal(off.notifications.enabled,false);
 const skipped=await run('chill-agent','comment','--id','2','--text','While Off');
 await toggle.focus();await page.keyboard.press('Space');await page.waitForFunction(()=>document.querySelector('[data-agent-extension="notifications"]')?.getAttribute('aria-pressed')==='true');
 assert.equal((await run('chill-settings','notice','--id','2','--event',String(skipped.id))).enabled,false);
 const event2=await run('chill-agent','comment','--id','2','--text','A useful result\nReady to review.');
 const prepared=await run('chill-settings','notice','--id','2','--event',String(event2.id));assert.equal(prepared.enabled,true);assert.equal(prepared.url,null);
 assert.equal((await run('chill-settings','notice','--id','2','--event',String(event2.id))).enabled,false);
 await run('chill-settings','notice-result','--id','2','--notice',prepared.noticeId,'--outcome','sent');
 assert.equal((await controls('2')).activity.entries[0].message,prepared.message);
 for(const width of [1280,390,320]){
  await page.setViewportSize({width,height:844});await go();
  const panel=page.locator('#agent-panel');assert.equal(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  const section=page.locator('.agent-auto').filter({has:page.getByRole('heading',{name:'Notifications',exact:true})});
  await section.getByText('History',{exact:true}).click();await section.getByText('View message',{exact:true}).click();
  assert.match(await section.innerText(),/Sent/);assert.match(await section.innerText(),/A useful result/);
  await page.screenshot({path:`/tmp/chill-notifications-${width}.png`});
 }
 assert.deepEqual(errors,[]);
 console.log('passed: saved setup request, Root isolation, first click and keyboard toggle, retained connection, no Off replay, idempotent notice/result, exact history, responsive layout');
}finally{await browser?.close();if(server&&server.exitCode===null){server.kill();await once(server,'exit');}await rm(root,{recursive:true,force:true});}
