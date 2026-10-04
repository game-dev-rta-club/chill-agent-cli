import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const source=await readFile(new URL('../public/extension-buttons.js',import.meta.url),'utf8');
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage();let enabled=false,reads=0,posts=0;
 await page.route('http://chill.test/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/extension-buttons.js')return route.fulfill({contentType:'text/javascript',body:source});
  if(path.startsWith('/api/')){if(route.request().method()==='POST'){posts++;enabled=route.request().postDataJSON().enabled;}else reads++;
   return route.fulfill({json:[{id:'continuation',label:'Auto-continue',rootId:'1',enabled,placement:'header',icon:'repeat'}]});}
  return route.fulfill({contentType:'text/html',body:'<div id="buttons"></div><script type="module">import {createExtensionButtons} from "/extension-buttons.js";window.ui=createExtensionButtons({container:document.querySelector("#buttons"),getGoalId:()=>"1"});ui.routeChanged();</script>'});
 });
 await page.goto('http://chill.test/');const button=page.getByRole('button',{name:'Auto-continue'});await button.waitFor();
 // Hold the very first pointer press while window-focus refresh completes.
 await button.evaluate(el=>window.originalButton=el);
 const box=await button.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
 await page.evaluate(async()=>{window.dispatchEvent(new Event('focus'));await window.ui.refresh();});
 await page.mouse.up();
 await page.waitForTimeout(150);
 assert.equal(posts,1,'the first click must survive a focus refresh between pointerdown and pointerup');
 assert.equal(await button.getAttribute('aria-pressed'),'true');
 assert.equal(await button.evaluate(el=>el===window.originalButton),true,'polling and saving preserve the button node');
 await button.focus();await page.keyboard.press('Space');await page.waitForTimeout(150);assert.equal(posts,2);assert.equal(enabled,false);
 assert.ok(reads>=3);
 console.log('passed: first pointer click survives focus refresh; stable button; keyboard toggles once');
}finally{await browser.close();}
