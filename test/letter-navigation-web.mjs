// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/letter-navigation-web.mjs
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {promisify} from 'node:util';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=await mkdtemp(join(tmpdir(),'chill-letter-navigation-'));
const env={...process.env,CHILL_AGENT_DATA_DIR:root,PORT:'0'},execute=promisify(execFile);
const cli=new URL('../bin/chill-agent.mjs',import.meta.url).pathname;
const run=async(...args)=>JSON.parse((await execute(process.execPath,[cli,...args],{env})).stdout);
let browser,server;
try {
 await run('create','--title','Letter navigation');
 await writeFile(join(root,'workspace/goals/1/brief.md'),'# Markdown Brief\n\nA short explanation.');await run('brief','update','--id','1');
 const file=await run('brief','path','--id','1','--format','html');
 await writeFile(file.path,'<!doctype html><html><head><style>body{font:16px sans-serif}.block{height:400px;padding:30px}</style></head><body><h1>Long HTML Brief</h1>'+Array.from({length:5},(_,i)=>`<section class="block">Section ${i}</section>`).join('')+'</body></html>');
 await run('brief','update','--id','1','--format','html');
 for(let i=0;i<6;i++)await run('comment','--id','1','--text',`Earlier comment ${i}`);
 const feedbackFile=join(root,'feedback.json');await writeFile(feedbackFile,JSON.stringify({text:'Earlier user message',requestId:'letter-navigation-delivery'}));
 const {feedback}=JSON.parse((await execute(process.execPath,[cli,'feedback','--id','1','--input-file',feedbackFile],{env})).stdout.trim().split('\n')[0]);
 const letter=await run('letter','--id','1','--title','Read this Letter','--text','Can you reach the whole page?');
 for(let i=0;i<6;i++)await run('comment','--id','1','--text',`Later comment ${i}`);
 server=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname,'--local'],{env,stdio:['ignore','pipe','pipe']});
 const url=await new Promise((resolve,reject)=>{server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});server.on('error',reject);server.on('exit',code=>reject(new Error(`Server exit ${code}`)));});
 browser=await chromium.launch({headless:true});const page=await browser.newPage(),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 // Force the Letter route to render before the HTML document finishes loading.
 await page.route('**/briefs/2/document',async route=>{await new Promise(resolve=>setTimeout(resolve,350));await route.continue();});
 // Delivery output can also appear above the Letter after the Goal is rendered.
 await page.route('**/api/goals/1/deliveries',async route=>{
  await new Promise(resolve=>setTimeout(resolve,500));
  await route.fulfill({json:[{eventId:feedback.id,status:'working',threadId:'test',work:{turnId:'test-turn',messages:[{id:'message',text:'Progress detail. '.repeat(200),at:1}]}}]});
 });
 const checkShell=async()=>assert.deepEqual(await page.evaluate(()=>({windowY:window.scrollY,headerTop:document.querySelector('.app-header').getBoundingClientRect().top,paneBottom:document.querySelector('main').getBoundingClientRect().bottom,viewport:innerHeight})),{windowY:0,headerTop:0,paneBottom:await page.evaluate(()=>innerHeight),viewport:await page.evaluate(()=>innerHeight)});
 const checkLetter=async()=>{
  try{await page.waitForFunction(id=>{const target=document.querySelector(`#event-${id}`),pane=document.querySelector('main').getBoundingClientRect(),rect=target?.getBoundingClientRect();return rect&&rect.top>=pane.top&&rect.bottom<=pane.bottom;},letter.id);}catch(error){console.log(await page.evaluate(id=>({hash:location.hash,scroll:document.querySelector('main').scrollTop,windowY:scrollY,frame:document.querySelector('iframe')?.getBoundingClientRect().toJSON(),pane:document.querySelector('main').getBoundingClientRect().toJSON(),letter:document.querySelector(`#event-${id}`)?.getBoundingClientRect().toJSON()}),letter.id));await page.screenshot({path:'/tmp/chill-letter-failure.png'});throw error;}
  await checkShell();
 };
 const checkEdges=async()=>{
  await page.locator('main').evaluate(el=>el.scrollTop=0);await checkShell();assert.ok((await page.locator('.breadcrumbs').boundingBox()).y>=0);
  await page.locator('main').evaluate(el=>el.scrollTop=el.scrollHeight);await checkShell();
  const button=await page.locator('.conversation-form button[type="submit"]').boundingBox();assert.ok(button.y+button.height<=await page.evaluate(()=>innerHeight));
 };
 for(const viewport of [{width:1400,height:960},{width:390,height:844}]){
  await page.setViewportSize(viewport);
  await page.goto('about:blank');
  await page.goto(`${url}/#/goal/1/letter/${letter.id}`);await page.waitForFunction(()=>document.querySelector('.html-brief-frame')?.clientHeight>2000);await checkLetter();await checkEdges();
  // Same-Goal navigation also remounts the asynchronous HTML frame.
  await page.goto(`${url}/#/goal/1`);await page.locator('.html-brief-frame').waitFor();
  await page.locator('[data-letter-link]').click();await page.waitForFunction(()=>document.querySelector('.html-brief-frame')?.clientHeight>2000);await checkLetter();await checkEdges();
  await page.locator('main').evaluate(el=>el.scrollTop=0);
  await page.locator('[data-letter-link]').click();await checkLetter();

 }
 // A stale frame must not scroll a different route when its late load completes.
 await page.goto(`${url}/#/goal/1/letter/${letter.id}`);await page.locator('.html-brief-frame').waitFor();
 await page.evaluate(()=>location.hash='#/goals');await page.locator('.goals-index').waitFor();
 await page.waitForTimeout(500);assert.equal(await page.locator('main').evaluate(el=>el.scrollTop),0);await checkShell();
 // Markdown routes use the same pane-only scrolling without a frame.
 await run('brief','update','--id','1','--format','markdown');
 for(const viewport of [{width:1400,height:960},{width:390,height:844}]){
  await page.setViewportSize(viewport);await page.goto('about:blank');await page.goto(`${url}/#/goal/1/letter/${letter.id}`);await checkLetter();await checkEdges();
  assert.equal(await page.locator('.html-brief-frame').count(),0);
 }
 assert.deepEqual(errors,[]);await page.screenshot({path:'/tmp/chill-letter-navigation.png'});
 console.log('passed: direct and same-Goal Letter links wait for HTML sizing, fixed shell stays at zero, top and composer remain reachable on desktop/mobile, and stale navigation is ignored');
} finally {await browser?.close();if(server&&server.exitCode===null){server.kill();await once(server,'exit');}await rm(root,{recursive:true,force:true});}
