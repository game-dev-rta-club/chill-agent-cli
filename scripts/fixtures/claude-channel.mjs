// Minimal one-way MCP fixture for the opt-in native qualification, not an adapter.
// No network listener, tools, permission relay or connection discovery.
import {readFile,readdir,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createInterface} from 'node:readline';

const directory=process.argv[2],trace=join(directory,'trace.jsonl');
const log=e=>appendFile(trace,JSON.stringify({at:Date.now(),...e})+'\n');
const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');
let initialized=false,busy=false;
const sent=new Set();
await log({event:'start',pid:process.pid});
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{
 try {
  if(line.length>65536)throw Error('Oversized request');
  const m=JSON.parse(line);
  if(m.method==='initialize') {
   void log({event:'initialize',requestedProtocol:m.params?.protocolVersion,protocol:'2025-11-25'});
   send({id:m.id,result:{protocolVersion:'2025-11-25',serverInfo:{name:'chill-probe',version:'0.0.0'},capabilities:{experimental:{'claude/channel':{}}},instructions:'One-way disposable chill-agent integration test. Saved feedback arrives as channel input; record its receipt using the main conversation Bash commands from the probe instructions.'}});
  }else if(m.method==='notifications/initialized'){initialized=true;void log({event:'initialized'});}
  else if(m.method==='ping')send({id:m.id,result:{}});
  else if(m.id!==undefined)send({id:m.id,error:{code:-32601,message:'Method not supported by this test fixture.'}});
 }catch{process.exitCode=1;lines.close();process.stdin.destroy();}
});
const timer=setInterval(async()=>{
 if(!initialized||busy)return;busy=true;
 try {
  for(const name of (await readdir(directory)).filter(n=>/^\d+\.json$/.test(n)).sort()){
   if(sent.has(name))continue;
   const item=JSON.parse(await readFile(join(directory,name),'utf8'));
   sent.add(name);await log({event:'write',eventId:item.eventId});
   send({method:'notifications/claude/channel',params:{content:item.content,meta:{event_id:String(item.eventId)}}});
  }
 }catch{await log({event:'error'});}
 finally{busy=false;}
},200);
lines.on('close',()=>{clearInterval(timer);});
process.stdout.on('error',()=>{clearInterval(timer);process.stdin.destroy();});
