import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {crc32,deflateSync} from 'node:zlib';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=await mkdtemp(join(tmpdir(),'chill-image-web-')),env={...process.env,CHILL_AGENT_DATA_DIR:root,PORT:'0'};
const execute=promisify(execFile),cli=new URL('../bin/chill-agent.mjs',import.meta.url).pathname;
const run=async(...args)=>JSON.parse((await execute(process.execPath,[cli,...args],{env})).stdout);
// A 400x300 PNG, so the browser can draw it once it arrives.
function png(width,height) {
  const chunk=(type,data)=>{const head=Buffer.alloc(8),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);head.write(type,4,'latin1');tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4),data])));return Buffer.concat([head,data,tail]);};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr.set([8,2,0,0,0],8);
  // Orange at the top fading to blue, so the placeholder's colours can be told apart.
  const rows=Array.from({length:height},(_,y)=>{const t=y/height,pixel=[Math.round(240-200*t),Math.round(140-40*t),Math.round(40+200*t)];return Buffer.from([0,...Array(width).fill(pixel).flat()]);});
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.concat(rows))),chunk('IEND',Buffer.alloc(0))]);
}
await run('create','--title','Slow images');
const server=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname,'--local'],{env,stdio:['ignore','pipe','pipe']});
const url=await new Promise((resolve,reject)=>{server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});server.on('error',reject);server.on('exit',code=>reject(new Error(`Server exit ${code}`)));});
let browser;
try {
 const {id}=await(await fetch(url+'/api/images',{method:'POST',headers:{Origin:url,'Content-Type':'image/png'},body:png(400,300)})).json();
 const path=await run('canvas','path','--id','1','--format','html');
 await writeFile(path.path,`<h2>Before the image</h2><img src="/api/images/${id}" alt="Screen"><p id="after">After the image</p>`);
 await run('canvas','update','--id','1','--format','html');
 await run('reply','--id','1','--text',`Look at this ![Screen](/api/images/${id})`);
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1056,height:1000}}),errors=[];
 page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 // Hold every image, as a slow connection would, until the checks below are done.
 let release;const held=new Promise(resolve=>{release=resolve;});
 await page.route('**/api/images/*',async route=>{await held;await route.continue();});
 await page.goto(url+'/#/goal/1');
 const frame=page.frameLocator('.html-brief-frame');
 await frame.locator('img[data-image-placeholder]').waitFor({state:'attached'});
 // The Canvas shows everything after the image while the image is still loading.
 await page.locator('.html-brief-frame[style*="height"]').waitFor({state:'attached'});
 const fits=()=>page.locator('.html-brief-frame').evaluate(el=>el.getBoundingClientRect().height>=el.contentDocument.querySelector('#after').getBoundingClientRect().bottom);
 assert.ok(await fits(),'the Canvas frame grows past the text below a loading image');
 const box=await frame.locator('img').boundingBox();assert.ok(box.height>100&&Math.abs(box.width/box.height-4/3)<.02,'the loading Canvas image keeps its shape');
 const comment=page.locator('.timeline-entry img[data-image-placeholder]');await comment.waitFor({state:'attached'});
 const shown=await comment.boundingBox();assert.ok(shown.height>100&&Math.abs(shown.width/shown.height-4/3)<.02,'the loading comment image keeps its shape');
 await page.screenshot({path:'/tmp/chill-image-placeholder.png'});
 release();
 await frame.locator('img[data-image-placeholder]').waitFor({state:'detached'});
 await page.locator('.timeline-entry img[data-image-placeholder]').waitFor({state:'detached'});
 assert.ok(await fits());
 const loaded=await frame.locator('img').boundingBox();assert.ok(Math.abs(loaded.height-box.height)<1,'the Canvas image does not move when it arrives');
 // The first browser to show the image saves its colours; the next view uses them.
 const saved=async()=>(await(await fetch(`${url}/api/image-sizes?ids=${id}`)).json()).sizes[id].thumbhash;
 for(let i=0;i<100&&!(await saved());i++)await new Promise(r=>setTimeout(r,50));
 assert.ok(await saved(),'the ThumbHash is saved');
 let releaseAgain;const heldAgain=new Promise(resolve=>{releaseAgain=resolve;});
 await page.unroute('**/api/images/*');await page.route('**/api/images/*',async route=>{await heldAgain;await route.continue();});
 // A new page, so the browser does not reuse the image it already has.
 const next=await browser.newPage({viewport:{width:1056,height:1000}});next.on('pageerror',e=>errors.push(e.message));
 await next.route('**/api/images/*',async route=>{await heldAgain;await route.continue();});
 await next.goto(url+'/#/goal/1');
 const coloured=next.frameLocator('.html-brief-frame').locator('img[data-thumbhash][style*="data:image/png"]');await coloured.waitFor({state:'attached'});
 await next.locator('.timeline-entry img[data-thumbhash][style*="data:image/png"]').waitFor({state:'attached'});
 await next.screenshot({path:'/tmp/chill-image-thumbhash.png'});
 releaseAgain();
 await next.frameLocator('.html-brief-frame').locator('img[data-image-placeholder]').waitFor({state:'detached'});
 assert.equal(await next.frameLocator('.html-brief-frame').locator('img').getAttribute('style'),'','the placeholder colours are removed once the image arrives');
 // On a fast connection an image is often loaded before the Web looks at it; its colours are saved too.
 const second=(await(await fetch(url+'/api/images',{method:'POST',headers:{Origin:url,'Content-Type':'image/png'},body:png(300,200)})).json()).id;
 await run('reply','--id','1','--text',`Another ![Fast](/api/images/${second})`);
 await next.reload();
 const savedSecond=async()=>(await(await fetch(`${url}/api/image-sizes?ids=${second}`)).json()).sizes[second].thumbhash;
 for(let i=0;i<100&&!(await savedSecond());i++)await new Promise(r=>setTimeout(r,50));
 assert.ok(await savedSecond(),'an image loaded at once also gets its ThumbHash');
 assert.deepEqual(errors,[]);
 console.log('image placeholder web checks passed');
} finally {
 await browser?.close();server.kill();await rm(root,{recursive:true,force:true});
}
