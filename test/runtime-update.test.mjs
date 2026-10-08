import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRuntimeUpdater,performRuntimeUpdate,runtimeUpdateProvider,launchUpdateWorker} from '../lib/runtime-update.mjs';
import {readJson,writeJsonAtomically} from '../lib/storage.mjs';
const a='a'.repeat(40),b='b'.repeat(40),c='c'.repeat(40);
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'chill-update-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 return {directory,root:join(directory,'old'),port:4173,duration:'3d',supported:true};
}
test('detection is read-only, unavailable without a valid candidate, and supports equal-version different commits',async t=>{
 const options=await fixture(t);let key=b,acquires=0,launches=0;
 const provider=async()=>({current:async()=>a,candidate:async()=>({key}),acquire:async()=>acquires++});
 const updater=createRuntimeUpdater({...options,provider,launch:async()=>launches++});
 assert.equal((await updater.status()).available,true);
 key=a;assert.equal((await updater.status()).available,false);
 key='invalid';assert.equal((await updater.status()).available,false);
 assert.equal(acquires,0);assert.equal(launches,0);
 assert.equal(await readJson(join(options.directory,'runtime','update.json')),null);
 assert.equal((await createRuntimeUpdater({...options,supported:false,provider}).status()).available,false);
});
test('two clicks launch once; stale confirmation and launch failure do not change the runtime',async t=>{
 const options=await fixture(t);let launches=0;
 const provider=async()=>({current:async()=>a,candidate:async()=>({key:b})});
 const updater=createRuntimeUpdater({...options,provider,launch:async()=>{launches++;}});
 await assert.rejects(updater.start({candidate:c,id:randomUUID()}),/更新内容が変わりました/);
 const results=await Promise.all([updater.start({candidate:b,id:randomUUID()}),updater.start({candidate:b,id:randomUUID()})]);
 assert.equal(launches,1);assert.equal(results[0].id,results[1].id);
 assert.equal(await readJson(join(options.directory,'runtime','installation.json')),null);
 const other=await fixture(t);
 const failed=createRuntimeUpdater({...other,provider,launch:async()=>{throw Error('launch failed');}});
 await assert.rejects(failed.start({candidate:b,id:randomUUID()}),/開始できませんでした/);
 assert.equal((await failed.status()).phase,'idle');assert.ok((await failed.status()).error);
});
async function worker(t,{acquireError=false,changePin=false,changePointer=false,restartError=false}={}){
 const options=await fixture(t),id=randomUUID(),target=join(options.directory,'new'),prepared=join(options.directory,'snapshot');
 let key=b;const calls=[];
 const provider=async()=>({candidate:async()=>({key}),acquire:async()=>{
  calls.push('acquire');if(acquireError)throw Error('download failed');if(changePin)key=c;
  if(changePointer)await writeJsonAtomically(join(options.directory,'runtime','installation.json'),{root:'another'});
  return target;
 }});
 const prepare=async root=>{calls.push(['prepare',root]);return {root:root===target?prepared:options.root};};
 const run=async(_,args,config)=>{calls.push(['restart',args[0],config.env.CHILL_AGENT_DATA_DIR,config.env.PORT]);if(restartError&&args[0].startsWith(prepared))throw Error('health failed');};
 await writeJsonAtomically(join(options.directory,'runtime','update.json'),{...options,id,candidate:b,phase:'preparing',at:Date.now()});
 return {...options,id,provider,prepare,run,calls,target,prepared};
}
test('worker acquires before switching; restarts the immutable snapshot and preserves workspace and port',async t=>{
 const f=await worker(t);await performRuntimeUpdate(f);
 assert.deepEqual(f.calls,['acquire',['prepare',f.target],['restart',join(f.prepared,'bin/chill-server.mjs'),f.directory,'4173']]);
 assert.equal((await readJson(join(f.directory,'runtime','update.json'))).phase,'complete');
});
test('acquisition failure, changed source and changed pointer never stop the old server',async t=>{
 for(const options of [{acquireError:true},{changePin:true},{changePointer:true}]){
  const f=await worker(t,options);await assert.rejects(performRuntimeUpdate(f));
  assert.deepEqual(f.calls,['acquire']);assert.equal((await readJson(join(f.directory,'runtime','update.json'))).phase,'failed');
 }
});
test('failed restart restores the previous runtime and records failure',async t=>{
 const f=await worker(t,{restartError:true});await assert.rejects(performRuntimeUpdate(f),/health failed/);
 assert.deepEqual(f.calls.slice(-2),[['prepare',f.root],['restart',join(f.root,'bin/chill-server.mjs'),f.directory,'4173']]);
 assert.match((await readJson(join(f.directory,'runtime','update.json'))).detail,/Previous runtime restored/);
});
test('provider path is package-owned; independent launchd job uses fixed worker and argument array',async t=>{
 const f=await fixture(t);await mkdir(f.root,{recursive:true});
 await writeFile(join(f.root,'extensions.json'),JSON.stringify({runtimeUpdates:'https://bad/module.mjs'}));
 await assert.rejects(runtimeUpdateProvider(f.root),/Invalid runtime update provider/);
 let command,args;
 await launchUpdateWorker({...f,id:randomUUID(),run:async(c,a)=>{command=c;args=a;}});
 assert.equal(command,'/bin/launchctl');assert.equal(args[0],'submit');
 assert.equal(args.at(-5),join(f.root,'bin/chill-runtime-update.mjs'));assert.equal(args.at(-4),f.directory);
});
