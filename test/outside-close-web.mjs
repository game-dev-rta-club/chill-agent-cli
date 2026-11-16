// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/outside-close-web.mjs
// Every menu closes on a click outside it, on the page and inside the Canvas.
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {promisify} from 'node:util';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=await mkdtemp(join(tmpdir(),'chill-outside-close-'));
const env={...process.env,CHILL_AGENT_DATA_DIR:root,CODEX_HOME:root,PORT:'0',CHILL_AGENT_EXTENSIONS:'none'};
const cli=new URL('../bin/chill-agent.mjs',import.meta.url).pathname,exec=promisify(execFile);
const run=async(...args)=>JSON.parse((await exec(process.execPath,[cli,...args],{env})).stdout);
let server,browser;
try{
 await run('create','--title','Root');
 const brief=await run('canvas','path','--id','1','--format','html');await writeFile(brief.path,'<style>body{height:950px;padding:25px}</style><h1>Deliverable</h1><p>Click inside the Canvas here.</p>');await run('canvas','update','--id','1','--format','html');
 server=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname,'--local'],{env,stdio:['ignore','pipe','pipe']});
 const url=await new Promise((resolve,reject)=>{server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});server.on('error',reject);server.on('exit',c=>reject(Error(`Server exit ${c}`)));});
 browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1400,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`${url}/#/goal/1`);await page.locator('#goal-title').filter({hasText:'Root'}).waitFor();
 const canvas=page.locator('.html-brief-frame').contentFrame().getByText('Click inside the Canvas here.');await canvas.waitFor();
 const more=page.getByRole('button',{name:'More',exact:true});
 const menus=[
  ['Tab icon',()=>page.locator('.brand-mark').click(),page.getByRole('dialog',{name:'Tab icon'})],
  ['More',()=>more.click(),{isVisible:async()=>await more.getAttribute('aria-expanded')==='true'}],
  ['Color theme',async()=>{await more.click();await page.getByRole('button',{name:'Color theme',exact:true}).click();},page.getByRole('dialog',{name:'Color theme'})],
  ['Notification',()=>page.locator('#letters-button').click(),page.locator('#letters-panel')],
  ['Autonomy',()=>page.locator('[data-autonomy-button]').first().click(),page.locator('#autonomy-panel')],
  ['Agent',()=>page.getByRole('button',{name:'Agent',exact:true}).click(),page.locator('#agent-panel')],
 ];
 const closes=async(name,panel)=>{for(let i=0;i<40&&await panel.isVisible();i++)await page.waitForTimeout(50);assert.equal(await panel.isVisible(),false,`${name} closes`);};
 for(const [name,open,panel] of menus){
  for(const [where,click] of [['Canvas',()=>canvas.click()],['page',()=>page.mouse.click(4,450)]]){
   await open();assert.equal(await panel.isVisible(),true,`${name} opens`);
   await click();await closes(`${name} on a ${where} click`,panel);
  }
 }
 assert.deepEqual(errors,[]);console.log(`PASS: ${menus.map(m=>m[0]).join(', ')} close on a click in the Canvas and on the page`);
}finally{await browser?.close();if(server&&server.exitCode===null){server.kill();await once(server,'exit');}await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
