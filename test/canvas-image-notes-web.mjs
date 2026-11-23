import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {deflateSync,crc32} from 'node:zlib';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=await mkdtemp(join(tmpdir(),'chill-canvas-image-notes-')),env={...process.env,CHILL_AGENT_DATA_DIR:root,PORT:'0'};
const execute=promisify(execFile),cli=new URL('../bin/chill-agent.mjs',import.meta.url).pathname;
const run=async(...args)=>JSON.parse((await execute(process.execPath,[cli,...args],{env})).stdout);
const png=(w,h)=>{const chunk=(type,data)=>{const b=Buffer.alloc(12+data.length);b.writeUInt32BE(data.length);b.write(type,4);data.copy(b,8);b.writeUInt32BE(crc32(b.subarray(4,8+data.length)),8+data.length);return b;};
 const head=Buffer.alloc(13);head.writeUInt32BE(w);head.writeUInt32BE(h,4);head.set([8,0,0,0,0],8);
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('IDAT',deflateSync(Buffer.alloc((w+1)*h,0x80))),chunk('IEND',Buffer.alloc(0))]);};
await run('create','--title','Canvas image notes');
const file=join(root,'figure.png');await writeFile(file,png(160,90));const image=await run('image','--file',file);
let version=0;
async function publish(format){
 version++;const path=await run('canvas','path','--id','1','--format',format);
 await writeFile(path.path,format==='html'?`<!doctype html><html><body><h1>Deliverable ${version}</h1><img src="${image.src}" alt="Figure" width="320"></body></html>`:`# Deliverable ${version}\n\n![Figure](${image.src})`);
 await run('canvas','update','--id','1','--format',format);
}
const server=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname,'--local'],{env,stdio:['ignore','pipe','pipe']});
const url=await new Promise(resolve=>server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);}));
let browser;
try{
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1056,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
 // A note on a Canvas image stays on the version it was made on, as a text note does.
 for(const [format,canvas] of [['markdown',page],['html',page.frameLocator('.html-brief-frame')]]){
  await publish(format);const noted=version;
  await page.goto(`${url}/?v${version}#/goal/1/v${noted}`);await canvas.getByRole('heading',{name:`Deliverable ${noted}`,exact:true}).waitFor();
  await canvas.locator('.brief-body .annotatable-image img').click();
  const area=page.locator('.image-area-dialog');await area.waitFor({state:'visible'});
  await area.getByRole('button',{name:'Whole image',exact:true}).click();await area.getByRole('button',{name:'Next',exact:true}).click();
  const editor=page.locator('.annotation-form');await editor.locator('textarea').fill(`Note on v${noted}`);await editor.getByRole('button',{name:'Save',exact:true}).click();await editor.waitFor({state:'hidden'});
  const response=page.waitForResponse(r=>r.url().endsWith('/feedback')&&r.request().method()==='POST');
  await page.locator('.conversation-form').getByRole('button',{name:'Comment',exact:true}).click();
  const note=(await (await response).json()).feedback.annotations[0];
  assert.deepEqual([note.imageId,note.source],[image.id,{kind:'brief',version:noted}]);
  await canvas.locator('.brief-body .image-note-box').waitFor();
  await publish(format);await canvas.getByRole('heading',{name:`Deliverable ${version}`,exact:true}).waitFor();
  await canvas.locator('.brief-body .annotatable-image img').waitFor();
  assert.equal(await canvas.locator('.brief-body .image-note-box').count(),0,`${format}: the note leaves with its version`);
  await page.goto(`${url}/?v${version}#/goal/1/v${noted}`);await canvas.getByRole('heading',{name:`Deliverable ${noted}`,exact:true}).waitFor();
  await canvas.locator('.brief-body .image-note-box').waitFor();
 }
 assert.deepEqual(errors,[]);console.log('passed: Canvas image notes show only on their version, Markdown and HTML');
}finally{await browser?.close();server.kill();await once(server,'exit');await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
