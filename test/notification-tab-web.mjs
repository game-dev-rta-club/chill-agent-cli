import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=await mkdtemp(join(tmpdir(),'chill-notification-tab-')),env={...process.env,CHILL_AGENT_DATA_DIR:root,PORT:'0'};
const execute=promisify(execFile),cli=new URL('../bin/chill-agent.mjs',import.meta.url).pathname;
const run=async(...args)=>JSON.parse((await execute(process.execPath,[cli,...args],{env})).stdout);
// Root 1 holds Goals 2 and 3; Root 4 is another Root open in its own tab.
await run('create','--title','First Root');await run('create','--title','Child','--parent','1');await run('create','--title','Other child','--parent','1');
await run('create','--title','Second Root');
const server=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname,'--local'],{env,stdio:['ignore','pipe','pipe']});
const url=await new Promise((resolve,reject)=>{server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});server.on('error',reject);server.on('exit',code=>reject(new Error(`Server exit ${code}`)));});
let browser;
try {
 browser=await chromium.launch({headless:true});const context=await browser.newContext(),errors=[];
 const open=async hash=>{const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(url+hash);await page.locator('.conversation-form').waitFor();return page;};
 const child=await open('/#/goal/2'),other=await open('/#/goal/4');
 const registered=context.waitForEvent('serviceworker');
 await child.evaluate(()=>navigator.serviceWorker.register('/extensions/web-notifications/sw.js',{scope:'/'}));
 const worker=await registered;
 // Each tab tells the worker which Goal and Root it shows.
 const answers=await worker.evaluate(async()=>Promise.all((await clients.matchAll({type:'window',includeUncontrolled:true})).map(ask)));
 assert.deepEqual(answers.map(a=>`${a.goalId}/${a.rootId}`).sort(),['2/1','4/4']);
 // focus() needs the click's permission, which a test cannot give; the tab choice happens before it.
 const notify=data=>worker.evaluate(data=>openGoal(data).catch(()=>{}),data);
 await notify({url:'/#/goal/3/letter/9',rootId:'1'});
 await child.waitForURL(/#\/goal\/3\/letter\/9$/);
 assert.match(other.url(),/#\/goal\/4$/,'a tab of another Root is left alone');
 // A tab already showing the notified Goal wins over another tab of the same Root.
 const exact=await open('/#/goal/2');
 await notify({url:'/#/goal/2',rootId:'1'});await notify({url:'/#/goal/2/letter/7',rootId:'1'});
 await exact.waitForURL(/#\/goal\/2\/letter\/7$/);
 assert.match(child.url(),/#\/goal\/3\/letter\/9$/,'the other tab of that Root keeps its page');
 // With no tab of the Root, no open tab is changed.
 await notify({url:'/#/goal/1',rootId:'99'});
 await new Promise(r=>setTimeout(r,300));
 assert.deepEqual([child.url(),other.url(),exact.url()].map(u=>new URL(u).hash),['#/goal/3/letter/9','#/goal/4','#/goal/2/letter/7']);
 assert.deepEqual(errors,[]);
 console.log('notification tab web checks passed');
} finally {
 await browser?.close();server.kill();await rm(root,{recursive:true,force:true});
}
