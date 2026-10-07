// Optional browser interaction check: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node test/letters-menu-web.mjs
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const root=new URL('../public',import.meta.url).pathname;
const browser=await chromium.launch({headless:true});
for(const width of [390,1280]){
 const page=await browser.newPage({viewport:{width,height:850}});
 await page.route('http://test.local/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/')return route.fulfill({contentType:'text/html',body:`<link rel="stylesheet" href="/workspace.css"><div class="app-header"><div class="header-inner"><a class="brand">chill.</a><div class="header-actions"><button class="agent-trigger">Agent</button><button id="letters" class="header-letters"></button><span id="more" class="extension-buttons"></span></div></div></div><section id="panel" class="agent-panel letters-panel" hidden></section><script type="module">import {createLettersMenu} from '/letters-menu.js';import {createExtensionButtons} from '/extension-buttons.js';window.menu=createLettersMenu({button:document.querySelector('#letters'),panel:document.querySelector('#panel')});createExtensionButtons({container:document.querySelector('#more'),getGoalId:()=>null});window.update=(count)=>menu.update([{id:'1',title:'A calm project'}],Array.from({length:count},(_,i)=>({id:i+1,goalId:'1',type:'letter',author:'agent',title:'Ready for your next decision '+(i+1)})),'1');update(0);</script>`});
  try{return route.fulfill({contentType:path.endsWith('.css')?'text/css':'text/javascript',body:await readFile(root+path)});}catch{return route.fulfill({status:404,body:''});}
 });
 await page.goto('http://test.local');
 const button=page.locator('#letters');
 await button.waitFor();await page.waitForFunction(()=>window.update);
 assert.match(await button.getAttribute('aria-label'),/0 unanswered · Off/);
 await button.click();await page.getByText('No unanswered Letters.').waitFor();
 await page.keyboard.press('Escape');assert.equal(await page.locator('#panel').isVisible(),false);
 await page.evaluate(()=>update(2));assert.match(await button.getAttribute('aria-label'),/2 unanswered · On/);
 await button.click();assert.equal(await page.locator('#panel a').count(),2);
 
 await page.locator('#panel a').first().click();assert.equal(new URL(page.url()).hash,'#/goal/1/letter/1');assert.equal(await page.locator('#panel').isVisible(),false);
 await page.getByRole('button',{name:'More',exact:true}).click();await page.getByRole('link',{name:'Goals',exact:true}).click();assert.equal(new URL(page.url()).hash,'#/goals');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.close();
}
await browser.close();console.log('Letters and More interaction passed on desktop and mobile');
