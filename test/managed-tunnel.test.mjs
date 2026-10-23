import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {managedTunnelPaths,startManagedTunnel,stopManagedTunnel} from '../lib/managed-tunnel.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tunnelStatePath} from '../lib/tunnel.mjs';
const run=promisify(execFile);

test('managed connector survives Web release, reattaches once, and stops on Off',{skip:process.platform!=='darwin',timeout:15000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'chill-managed-test-'));const port=51493;
 const binary=join(directory,'cloudflared');const previous=process.env.CHILL_AGENT_CLOUDFLARED_PATH;
 await writeFile(binary,`#!${process.execPath}\nconsole.log('https://test-managed-tunnel.trycloudflare.com');console.log('Registered tunnel connection');setInterval(()=>{},1000);`,{mode:0o700});
 process.env.CHILL_AGENT_CLOUDFLARED_PATH=binary;
 let first,second,error,origin;
 const options={directory,port,remote:{mode:'quick'},onOrigin:v=>origin=v,onFailure:e=>error=e};
 const wait=async()=>{for(let i=0;i<100&&!origin&&!error;i++)await delay(50);assert.ifError(error);assert.ok(origin);};
 try{
  first=await startManagedTunnel(options);await wait();
  const before=JSON.parse(await readFile(tunnelStatePath(directory,port),'utf8'));
  await first.release();origin=null;
  second=await startManagedTunnel(options);await wait();
  const after=JSON.parse(await readFile(tunnelStatePath(directory,port),'utf8'));
  assert.equal(after.connectorPid,before.connectorPid);assert.equal(after.url,before.url);
  await second();second=null;
  for(let i=0;i<100;i++){try{process.kill(before.connectorPid,0);}catch{break;}await delay(20);}
  assert.throws(()=>process.kill(before.connectorPid,0));
  await assert.rejects(readFile(tunnelStatePath(directory,port)),{code:'ENOENT'});
 }finally{await first?.release();await second?.();await stopManagedTunnel(directory,port);await rm(directory,{recursive:true,force:true});if(previous===undefined)delete process.env.CHILL_AGENT_CLOUDFLARED_PATH;else process.env.CHILL_AGENT_CLOUDFLARED_PATH=previous;}
});
test('on Windows the connector is its own task: it survives Web release, reattaches once, and stops on Off',{skip:process.platform!=='win32',timeout:150000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'chill-managed-test-'));const port=51494;
 const fake=join(directory,'fake-cloudflared.mjs');
 await writeFile(fake,`console.log('https://test-managed-tunnel.trycloudflare.com');console.log('Registered tunnel connection');setInterval(()=>{},1000);`);
 let first,second,error,origin;
 const options={directory,port,remote:{mode:'quick'},onOrigin:v=>origin=v,onFailure:e=>error=e,command:async()=>[process.execPath,fake]};
 const wait=async()=>{for(let i=0;i<900&&!origin&&!error;i++)await delay(50);assert.ifError(error);assert.ok(origin);};
 const {task}=managedTunnelPaths(directory,port);
 const registered=async()=>{try{await run('schtasks',['/Query','/TN',task],{windowsHide:true});return true;}catch{return false;}};
 try{
  first=await startManagedTunnel(options);await wait();
  const before=JSON.parse(await readFile(tunnelStatePath(directory,port),'utf8'));
  assert.equal(before.url,'https://test-managed-tunnel.trycloudflare.com');
  assert.equal(await registered(),false,'the registration is removed once the connector runs');
  await first.release();first=null;origin=null;
  process.kill(before.connectorPid,0);
  second=await startManagedTunnel(options);await wait();
  const after=JSON.parse(await readFile(tunnelStatePath(directory,port),'utf8'));
  assert.equal(after.connectorPid,before.connectorPid,'the next Web reattaches to the same connector');assert.equal(after.url,before.url);
  await second();second=null;
  for(let i=0;i<100;i++){try{process.kill(before.connectorPid,0);}catch{break;}await delay(50);}
  assert.throws(()=>process.kill(before.connectorPid,0));
  await assert.rejects(readFile(tunnelStatePath(directory,port)),{code:'ENOENT'});
 }finally{await first?.release();await second?.();await stopManagedTunnel(directory,port);await rm(directory,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
});
test('on Windows a connector that exits before its URL fails at once, not after the 45-second wait',{skip:process.platform!=='win32',timeout:60000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'chill-managed-test-'));const port=51495;
 const fake=join(directory,'fake-cloudflared.mjs');await writeFile(fake,`process.exit(2);`);
 let stop,error;const started=Date.now();
 try{
  stop=await startManagedTunnel({directory,port,remote:{mode:'quick'},onOrigin:()=>{},onFailure:e=>error=e,command:async()=>[process.execPath,fake]});
  for(let i=0;i<600&&!error;i++)await delay(50);
  assert.match(error?.message||'',/Cloudflare tunnel stopped/);assert.ok(Date.now()-started<30000);
 }finally{await stop?.();await stopManagedTunnel(directory,port);await rm(directory,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
});
