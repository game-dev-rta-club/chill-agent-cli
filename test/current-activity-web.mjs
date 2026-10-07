// Optional browser check. Never controls a live agent.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
let status='working',posts=[];
const data=()=>({connected:true,threadId:'thread',settings:{},usage:[],queue:{items:[]},work:{status,goalId:'1',title:'Current task'},control:{turnId:'turn'},capabilities:{stop:status==='working',resume:status==='paused'},currentMessages:[{text:'Checking the current result.'}]});
const server=createServer(async(req,res)=>{
 if(req.url==='/api/goals/1/agent/control'){
  let body='';for await(const part of req)body+=part;
  const input=JSON.parse(body);posts.push(input);status=input.action==='stop'?'paused':'working';res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data()));return;
 }
 if(req.url.startsWith('/api/')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url.includes('/extensions')?[]:data()));return;}
 if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end(`<button id="open">Agent</button><aside id="panel" hidden><button data-agent-close>Close</button><button data-agent-refresh>Refresh</button><div id="content"></div></aside><script type="module">import {createAgentMenu} from '/agent-menu.js';createAgentMenu({button:document.querySelector('#open'),panel:document.querySelector('#panel'),content:document.querySelector('#content'),getGoalId:()=> '1'});</script>`);return;}
 try{res.setHeader('Content-Type','text/javascript');res.end(await readFile(new URL('../public/'+req.url.slice(1),import.meta.url)));}catch{res.statusCode=404;res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true});
try{
 for(const width of [1280,390]){
  status='working';const page=await browser.newPage({viewport:{width,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.getByRole('button',{name:'Agent',exact:true}).click();
  await page.getByText('Checking the current result.').waitFor();assert.equal(await page.getByText('Recent runs').count(),0);
  await page.getByRole('button',{name:'Pause'}).click();await page.getByRole('button',{name:'Resume'}).waitFor();
  await page.getByRole('button',{name:'Resume'}).click();await page.getByRole('button',{name:'Pause'}).waitFor();
  assert.deepEqual(errors,[]);await page.close();
 }
 assert.deepEqual(posts.map(p=>p.action),['stop','resume','stop','resume']);
 assert.ok(posts.every(p=>p.scope==='current'&&p.threadId==='thread'&&p.turnId==='turn'));
 assert.equal(new Set(posts.map(p=>p.requestId)).size,4);
 console.log('Current Activity desktop/mobile controls passed');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
