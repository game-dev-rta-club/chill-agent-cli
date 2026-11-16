import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cloudflaredPath,tunnelStatePath} from './tunnel.mjs';
import {namedTunnelConfig} from './message-settings.mjs';
import {writeJsonAtomically} from './goal-store.mjs';
import {readJson} from './storage.mjs';
import {commandLineOf,deleteTask,runHeadlessTask} from './web-service-windows.mjs';
const execute=promisify(execFile);
const xml=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
export function managedTunnelPaths(directory,port){
 const key=createHash('sha256').update(`${directory}:${port}`).digest('hex').slice(0,12);
 const label=`com.chill-agent.tunnel.${key}`;
 const folder=join(directory,'runtime',`web-${port}`);
 return {label,folder,root:directory,target:process.getuid?`gui/${process.getuid()}/${label}`:null,task:`\\chill-agent\\tunnel-${key}`,
  plist:join(folder,'tunnel.plist'),log:join(folder,'tunnel.log'),config:join(folder,'tunnel-config.json'),
  service:join(folder,'tunnel-service.json'),state:join(folder,'tunnel-state.json'),xml:join(folder,'tunnel-task.xml')};
}

// launchd owns the connector on macOS.
function launchdConnector(p){
 return {
  async loaded(){try{return Boolean((await execute('/bin/launchctl',['print',p.target])).stdout);}catch{return false;}},
  async pid(){try{return Number(/^\s*pid = (\d+)$/m.exec((await execute('/bin/launchctl',['print',p.target])).stdout)?.[1])||0;}catch{return null;}},
  async launch(argv){
   await writeFile(p.plist,`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>${p.label}</string><key>ProgramArguments</key><array>${argv.map(v=>`<string>${xml(v)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>StandardOutPath</key><string>${xml(p.log)}</string><key>StandardErrorPath</key><string>${xml(p.log)}</string></dict></plist>`,{mode:0o600});
   await execute('/bin/launchctl',['bootstrap',`gui/${process.getuid()}`,p.plist]);
  },
  async started(){},
  async stop(){try{await execute('/bin/launchctl',['bootout',p.target]);}catch(error){if(!/Could not find service|No such process/.test(error.stderr||''))throw error;}},
 };
}

// On Windows a Task Scheduler task runs the connector through the same small
// launcher as Web, outside Web's process tree, so stopping Web leaves it running.
// The registration is removed once the connector runs; its state file names it.
function taskConnector(p,port,run=execute){
 const launcher=fileURLToPath(new URL('../bin/chill-web-task.mjs',import.meta.url));
 const ours=async pid=>{const line=await commandLineOf(pid,run);return line.includes(p.service)||line.includes(p.folder)||line.includes(`127.0.0.1:${port}`);};
 const running=async()=>{const s=await readJson(p.state);return s&&Number.isInteger(s.pid)&&alive(s.pid)?s:null;};
 return {
  async loaded(){const s=await running();return Boolean(s&&await ours(s.pid));},
  // 0 until the launcher records the connector; null once that connector has ended.
  async pid(){const s=await readJson(p.state);return !s?0:Number.isInteger(s.pid)&&alive(s.pid)?s.pid:null;},
  async launch([command,...args]){
   await rm(p.state,{force:true});
   await writeJsonAtomically(p.service,{command,args,cwd:p.root,log:p.log,state:p.state});
   await runHeadlessTask({name:p.task,file:p.xml,args:[process.execPath,launcher,p.service],cwd:p.root,description:'chill-agent public link',execute:run});
  },
  started:()=>deleteTask(p.task,run),
  async stop(){
   const s=await readJson(p.state);
   for(const pid of [s?.task,s?.pid])if(Number.isInteger(pid)&&alive(pid)&&await ours(pid))await run('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true}).catch(()=>{});
   await deleteTask(p.task,run);await rm(p.state,{force:true});
  },
 };
}
const connectorFor=(p,port)=>process.platform==='win32'?taskConnector(p,port):launchdConnector(p);

export async function stopManagedTunnel(directory,port){
 const p=managedTunnelPaths(directory,port);
 await connectorFor(p,port).stop();
 await rm(tunnelStatePath(directory,port),{force:true});
}
// The connector outlives the replaceable Web process; a restarted Web reattaches to it.
// `command` gives the program and leading arguments, so tests can run a script.
export async function startManagedTunnel({directory,port,remote,onOrigin,onFailure,command=async()=>[await cloudflaredPath()]}){
 const p=managedTunnelPaths(directory,port),connector=connectorFor(p,port);await mkdir(p.folder,{recursive:true});
 const fingerprint=JSON.stringify(remote);
 let running=await connector.loaded();
 let previous;try{previous=await readFile(p.config,'utf8');}catch{}
 if(running && previous!==fingerprint){await stopManagedTunnel(directory,port);running=false;}
 if(!running){
  let args=['tunnel','--no-autoupdate','--url',`http://127.0.0.1:${port}`];
  if(remote.mode==='named'){
   const path=join(p.folder,'cloudflared.json');await writeJsonAtomically(path,namedTunnelConfig(remote,port));
   args=['tunnel','--no-autoupdate','--config',path,'run',remote.tunnelId];
  }else if(remote.mode!=='quick')throw Error('Tunnel mode must be quick or named.');
  const program=await command();
  await rm(tunnelStatePath(directory,port),{force:true});
  await writeFile(p.log,'',{mode:0o600});await writeFile(p.config,fingerprint,{mode:0o600});
  await connector.launch([...program,...args]);
 }
 let stopped=false,timer,announced=false;const deadline=Date.now()+45000;
 async function poll(){
  try{
   const pid=await connector.pid();
   // null: the job or connector is gone, so fail now; 0: it has not started yet.
   if(!pid){if(pid===null||announced||Date.now()>deadline)throw Error('Cloudflare tunnel stopped.');if(!stopped)timer=setTimeout(poll,100);return;}
   const log=await readFile(p.log,'utf8');
   const url=remote.mode==='named'?remote.url:/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com(?=[\s|"']|$)/.exec(log)?.[0];
   if(stopped)return;
   if(!announced&&url&&log.includes('Registered tunnel connection')){
    await writeJsonAtomically(tunnelStatePath(directory,port),{url,pid:process.pid,connectorPid:pid,managed:true,createdAt:new Date().toISOString()});
    await connector.started();
    if(stopped)return;announced=true;onOrigin(url);
   }
   if(!announced&&Date.now()>deadline)throw Error('Cloudflare did not establish a tunnel within 45 seconds.');
  }catch(error){if(!stopped){stopped=true;onOrigin(null);onFailure(error);}return;}
  if(!stopped)timer=setTimeout(poll,announced?2000:100);
 }
 void poll();
 const stop=async()=>{stopped=true;clearTimeout(timer);onOrigin(null);await stopManagedTunnel(directory,port);};
 stop.release=async()=>{stopped=true;clearTimeout(timer);};
 return stop;
}
