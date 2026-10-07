// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node test/theme-web.mjs
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {themes} from '../public/theme-catalog.js';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=await mkdtemp(join(tmpdir(),'chill-theme-web-'));let server,browser;
const env={...process.env,CHILL_AGENT_DATA_DIR:root,CODEX_HOME:root,PORT:'0',CHILL_AGENT_EXTENSIONS:'none'};
try{
 await promisify(execFile)(process.execPath,[new URL('../bin/chill-agent.mjs',import.meta.url).pathname,'create','--title','A calmer workspace'],{env});
 server=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname,'--local'],{env,stdio:['ignore','pipe','pipe']});
 const url=await new Promise((resolve,reject)=>{server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});server.on('error',reject);server.on('exit',c=>reject(Error(`Server exit ${c}`)));});
 browser=await chromium.launch();const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const open=async()=>{await page.getByRole('button',{name:'More',exact:true}).click();await page.getByRole('button',{name:'Color theme',exact:true}).click();};
 await page.goto(url+'/#/goal/1');await page.locator('#goal-title').filter({hasText:'A calmer'}).waitFor();await page.evaluate(()=>{const fixture=document.createElement('div');fixture.id='theme-status-fixture';fixture.innerHTML='<article class="timeline-entry letter-comment"><header class="letter-comment-heading"><h2 class="letter-comment-title">Open Letter</h2></header></article><article class="timeline-entry letter-comment is-answered"><header class="letter-comment-heading"><h2 class="letter-comment-title">Answered Letter</h2></header></article><span class="status working">Working</span><span class="status done">Done</span>';document.querySelector('.reading-pane').prepend(fixture);});await open();
 assert.equal(await page.locator('[data-theme-choice]').count(),18);
 const semanticColors={};
 for(const t of themes){await page.locator(`[data-theme-choice="${t.id}"]`).click();await page.waitForFunction(id=>document.documentElement.dataset.theme===id,t.id);await page.getByText('Saved for this project.',{exact:true}).waitFor();assert.equal(await page.locator(`[data-theme-choice="${t.id}"]`).getAttribute('aria-pressed'),'true');
  const colors=await page.locator('#theme-status-fixture').evaluate(el=>[...el.querySelectorAll('.letter-comment-title,.letter-comment-heading,.status')].map(node=>node.classList.contains('letter-comment-heading')?getComputedStyle(node).backgroundColor:getComputedStyle(node).color));
  const mode=t.kind==='dark'?'dark':'light';if(semanticColors[mode])assert.deepEqual(colors,semanticColors[mode],'status meanings stay constant across hues');else semanticColors[mode]=colors;
 }
 assert.notDeepEqual(semanticColors.dark,semanticColors.light,'dark statuses adjust contrast');
 for(const colors of Object.values(semanticColors)){assert.notEqual(colors[0],colors[2]);assert.notEqual(colors[1],colors[3]);assert.equal(colors[1],colors[4]);assert.equal(colors[3],colors[5]);}
 await page.locator('[data-theme-choice="gradient-rose"]').click();await page.waitForFunction(()=>document.documentElement.dataset.theme==='gradient-rose');await page.keyboard.press('Escape');await page.getByRole('button',{name:'More',exact:true}).click();await page.locator('#theme-status-fixture').screenshot({path:'/tmp/chill-theme-semantic-rose.png'});await open();
 for(const id of ['gradient-ocean','light-peach','dark-iris']){
  await page.locator(`[data-theme-choice="${id}"]`).click();await page.waitForFunction(id=>document.documentElement.dataset.theme===id,id);
  await page.screenshot({path:`/tmp/chill-theme-${id}.png`});
 }
 await page.keyboard.press('Escape');assert.equal(await page.getByRole('button',{name:'Color theme',exact:true}).evaluate(el=>el===document.activeElement),true);assert.equal(await page.getByRole('dialog',{name:'Color theme'}).isVisible(),false);
 await page.screenshot({path:'/tmp/chill-theme-dark-page.png'});await page.reload();await page.locator('#goal-title').waitFor();assert.equal(await page.locator('html').getAttribute('data-theme'),'dark-iris');
 assert.match(await (await fetch(url)).text(),/data-theme="dark-iris"/,'server applies preference before first paint');
 assert.equal((await fetch(url+'/api/workspace/theme',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://foreign.example'},body:'{"theme":"light-mint"}'})).status,403);
 assert.equal((await fetch(url+'/api/workspace/theme',{method:'POST',headers:{'Content-Type':'application/json',Origin:url},body:'{"theme":"unknown"}'})).status,400);
 await open();await page.route('**/api/workspace/theme',route=>route.request().method()==='POST'?route.fulfill({status:500,json:{error:'test'}}):route.continue());
 await page.locator('[data-theme-choice="light-mint"]').click();await page.getByText('Could not save. Your previous theme is unchanged.').waitFor();assert.equal(await page.locator('html').getAttribute('data-theme'),'dark-iris');await page.unroute('**/api/workspace/theme');
 await page.locator('[data-theme-choice="gradient-mint"]').click();await page.waitForFunction(()=>document.documentElement.dataset.theme==='gradient-mint');
 await page.keyboard.press('Escape');await page.setViewportSize({width:1400,height:900});await page.screenshot({path:'/tmp/chill-theme-original.png'});
 assert.deepEqual(errors,[]);console.log('PASS: 18 palettes, saved preference/first paint, error retention, origin validation, mobile picker and keyboard dismissal');
}finally{await browser?.close();server?.kill();await rm(root,{recursive:true,force:true});}
