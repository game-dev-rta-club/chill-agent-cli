import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startManagedTunnel,stopManagedTunnel} from '../lib/managed-tunnel.mjs';
import {tunnelStatePath} from '../lib/tunnel.mjs';

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
