import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {cloudflaredPath,tunnelStatePath} from './tunnel.mjs';
import {namedTunnelConfig} from './message-settings.mjs';
import {writeJsonAtomically} from './goal-store.mjs';
const execute=promisify(execFile);
const xml=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
export function managedTunnelPaths(directory,port){
 const label=`com.chill-agent.tunnel.${createHash('sha256').update(`${directory}:${port}`).digest('hex').slice(0,12)}`;
 const folder=join(directory,'runtime',`web-${port}`);
 return {label,folder,target:`gui/${process.getuid()}/${label}`,plist:join(folder,'tunnel.plist'),log:join(folder,'tunnel.log'),config:join(folder,'tunnel-config.json')};
}
export async function stopManagedTunnel(directory,port){
 const p=managedTunnelPaths(directory,port);
 try{await execute('/bin/launchctl',['bootout',p.target]);}catch(error){if(!/Could not find service|No such process/.test(error.stderr||''))throw error;}
 await rm(tunnelStatePath(directory,port),{force:true});
}
// launchd owns the connector independently of the replaceable Web process.
export async function startManagedTunnel({directory,port,remote,onOrigin,onFailure}){
 const p=managedTunnelPaths(directory,port);await mkdir(p.folder,{recursive:true});
 const fingerprint=JSON.stringify(remote);
 let running='';try{running=(await execute('/bin/launchctl',['print',p.target])).stdout;}catch{}
 let previous;try{previous=await readFile(p.config,'utf8');}catch{}
 if(running && previous!==fingerprint){await stopManagedTunnel(directory,port);running='';}
 if(!running){
  const binary=await cloudflaredPath();
  let args=['tunnel','--no-autoupdate','--url',`http://127.0.0.1:${port}`];
  if(remote.mode==='named'){
   const path=join(p.folder,'cloudflared.json');await writeJsonAtomically(path,namedTunnelConfig(remote,port));
   args=['tunnel','--no-autoupdate','--config',path,'run',remote.tunnelId];
  }else if(remote.mode!=='quick')throw Error('Tunnel mode must be quick or named.');
  await rm(tunnelStatePath(directory,port),{force:true});
  await writeFile(p.log,'',{mode:0o600});await writeFile(p.config,fingerprint,{mode:0o600});
  await writeFile(p.plist,`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>${p.label}</string><key>ProgramArguments</key><array>${[binary,...args].map(v=>`<string>${xml(v)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>StandardOutPath</key><string>${xml(p.log)}</string><key>StandardErrorPath</key><string>${xml(p.log)}</string></dict></plist>`,{mode:0o600});
  await execute('/bin/launchctl',['bootstrap',`gui/${process.getuid()}`,p.plist]);
 }
 let stopped=false,timer,announced=false;const deadline=Date.now()+45000;
 async function poll(){
  try{
   const state=(await execute('/bin/launchctl',['print',p.target])).stdout;
   const pid=Number(/^\s*pid = (\d+)$/m.exec(state)?.[1]);
   if(!pid){if(announced||Date.now()>deadline)throw Error('Cloudflare tunnel stopped.');if(!stopped)timer=setTimeout(poll,100);return;}
   const log=await readFile(p.log,'utf8');
   const url=remote.mode==='named'?remote.url:/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com(?=[\s|"']|$)/.exec(log)?.[0];
   if(stopped)return;
   if(!announced&&url&&log.includes('Registered tunnel connection')){
    await writeJsonAtomically(tunnelStatePath(directory,port),{url,pid:process.pid,connectorPid:pid,managed:true,createdAt:new Date().toISOString()});
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
