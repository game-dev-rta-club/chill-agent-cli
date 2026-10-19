import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {once} from 'node:events';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const directory=await mkdtemp(join(tmpdir(),'chill-connections-')),exec=promisify(execFile);
const binary=join(directory,'cloudflared');await writeFile(binary,`#!${process.execPath}\nconsole.error('https://phone-test.trycloudflare.com');setTimeout(()=>console.error('Registered tunnel connection'),100);setInterval(()=>{},1000);`);await chmod(binary,0o700);
const env={...process.env,CHILL_AGENT_DATA_DIR:directory,CODEX_HOME:directory,PORT:'0',CHILL_AGENT_CODEX_PATH:new URL('./fake-codex.mjs',import.meta.url).pathname,CHILL_AGENT_CLOUDFLARED_PATH:binary};
const cli=new URL('../dist/runtime/bin/chill-agent.mjs',import.meta.url).pathname;
let server,browser;
try{
 await exec(process.execPath,[cli,'create','--title','Your next quiet milestone','--thread-id','00000000-0000-0000-0000-000000000001'],{env});
 server=spawn(process.execPath,[new URL('../dist/runtime/server.mjs',import.meta.url).pathname,'--local'],{env,stdio:['ignore','pipe','pipe']});
 let logs='';server.stderr.on('data',b=>logs+=b);
 const url=await new Promise((resolve,reject)=>{server.stdout.on('data',b=>{logs+=b;const m=String(b).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});server.on('error',reject);server.on('exit',()=>reject(Error(logs)));});
 browser=await chromium.launch({headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  window.permissionCalls=[];window.permissionResult='granted';
  Object.defineProperty(Notification,'requestPermission',{value:()=>{window.permissionCalls.push(navigator.userActivation.isActive);return Promise.resolve(window.permissionResult);}});
  const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/browser-test',keys:{auth:btoa(String.fromCharCode(...new Uint8Array(16))),p256dh:btoa(String.fromCharCode(4,...new Uint8Array(64)))}};
  PushManager.prototype.getSubscription=async()=>null;PushManager.prototype.subscribe=async()=>({toJSON:()=>subscription});
 });
 for(const width of [1280,390,320]){
  await page.setViewportSize({width,height:850});await page.goto(`${url}/#/goal/1`);
  for(const name of ['Notifications','Public link','Auto-continue'])await page.getByRole('button',{name,exact:true}).waitFor();
  await page.getByRole('button',{name:'Auto-continue',exact:true}).click();await page.getByRole('switch',{name:'Auto-continue'}).waitFor();assert.equal(await page.getByRole('switch',{name:'Auto-continue'}).isChecked(),false);await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Public link',exact:true}).click();await page.getByRole('switch',{name:'Public link'}).waitFor();
  await page.getByRole('button',{name:'More about public access'}).click();assert.match(await page.getByRole('dialog').innerText(),/No API token/);
  const box=await page.getByRole('dialog').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width);
  await page.screenshot({path:`/tmp/chill-public-${width}.png`});await page.keyboard.press('Escape');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`no page overflow at ${width}`);
 }
 await page.setViewportSize({width:1280,height:850});
 await page.getByRole('button',{name:'Public link',exact:true}).click();
 await page.getByRole('switch',{name:'Public link'}).click();await page.getByRole('dialog',{name:'Create public link?'}).getByRole('button',{name:'Cancel',exact:true}).click();
 assert.equal(await page.getByRole('switch',{name:'Public link'}).isChecked(),false);assert.equal(await page.getByRole('dialog',{name:'Public link',exact:true}).isVisible(),true);
 await page.getByRole('switch',{name:'Public link'}).click();await page.getByRole('dialog',{name:'Create public link?'}).getByRole('button',{name:'Cancel',exact:true}).press('Escape');
 assert.equal(await page.getByRole('switch',{name:'Public link'}).isChecked(),false);assert.equal(await page.getByRole('dialog',{name:'Public link',exact:true}).isVisible(),true);
 await page.getByRole('switch',{name:'Public link'}).check();await page.getByRole('dialog',{name:'Create public link?'}).getByRole('button',{name:'Create link',exact:true}).click();await page.locator('.extension-qr').waitFor();assert.ok((await page.locator('.extension-qr').getAttribute('src')).startsWith('data:image/png'));
 assert.equal(await page.locator('.extension-url').getAttribute('href'),'https://phone-test.trycloudflare.com/#/goal/1');await page.screenshot({path:'/tmp/chill-public-on.png'});
 await page.getByRole('switch',{name:'Public link'}).uncheck();assert.equal((await fetch(url)).status,200);await page.keyboard.press('Escape');
 // On asks within the user gesture, and this browser's Off leaves others alone.
 await page.getByRole('button',{name:'Notifications',exact:true}).click();const toggle=page.getByRole('switch',{name:'Notifications'});await page.waitForFunction(()=>document.querySelector('.extension-panel input')?.disabled===false);
 assert.equal(await page.getByRole('button',{name:'Send test'}).count(),0);assert.equal(await page.getByText('History',{exact:true}).count(),0);
 assert.equal((await page.evaluate(()=>window.permissionCalls)).length,0);await page.evaluate(()=>window.permissionResult='denied');await toggle.click();await page.getByText('Allow notifications in your browser’s site settings, then try On again.').waitFor();assert.equal(await toggle.isChecked(),false);
 await page.evaluate(()=>window.permissionResult='granted');await toggle.check();await page.getByText('A confirmation will arrive shortly.').waitFor();assert.deepEqual(await page.evaluate(()=>window.permissionCalls),[true,true]);
 const other=await browser.newPage();await other.goto(`${url}/#/goal/1`);await other.getByRole('button',{name:'Notifications',exact:true}).click();await other.waitForFunction(()=>document.querySelector('.extension-panel input')?.disabled===false);
 assert.equal(await other.getByRole('switch',{name:'Notifications'}).isChecked(),false);assert.equal(await other.getByRole('button',{name:'Connect this device'}).count(),0);await other.close();
 await toggle.uncheck();await page.waitForFunction(()=>document.querySelector('.extension-panel input')?.disabled===false);
 assert.equal(await toggle.isChecked(),false);await page.screenshot({path:'/tmp/chill-notifications.png'});
 const response=await fetch(url+'/api/extensions/public-link/toggle',{method:'POST',headers:{Origin:'https://evil.test','Content-Type':'application/json'},body:'{"enabled":true}'});assert.equal(response.status,403);
 const sw=await fetch(url+'/extensions/web-notifications/sw.js');assert.equal(sw.headers.get('service-worker-allowed'),'/');assert.match(await sw.text(),/notificationclick/);
 assert.deepEqual(errors,[]);console.log('passed: 3 panels, responsive layout, no toggle on open, public start/stop/QR, permission gesture/denial, device-specific subscription/Off, CSRF, scoped assets');
}finally{await browser?.close();if(server&&server.exitCode===null){server.kill('SIGTERM');await once(server,'exit');}await rm(directory,{recursive:true,force:true});}
