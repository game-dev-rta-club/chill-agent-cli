import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {connectionExtensions} from '../lib/connection-extensions.mjs';

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'connection-extensions-')),root=join(dir,'runtime');await mkdir(root);
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const manifest=pathToFileURL(join(root,'extensions.json'));
 return {dir,root,manifest,save:connectionExtensions=>writeFile(manifest,JSON.stringify({connectionExtensions}))};
}
test('connection hooks load only composed modules, and extensions=none disables loading',async t=>{
 const f=await fixture(t);assert.deepEqual(await connectionExtensions(f.manifest),{});
 await writeFile(join(f.root,'provider.mjs'),'export const id="fixture";');await f.save({sample:'./provider.mjs'});
 assert.equal((await connectionExtensions(f.manifest)).sample.id,'fixture');
 const old=process.env.CHILL_AGENT_EXTENSIONS;process.env.CHILL_AGENT_EXTENSIONS='none';
 try{assert.deepEqual(await connectionExtensions(f.manifest),{});}finally{if(old===undefined)delete process.env.CHILL_AGENT_EXTENSIONS;else process.env.CHILL_AGENT_EXTENSIONS=old;}
});
test('connection hooks reject outside-runtime paths and symlinks',async t=>{
 const f=await fixture(t),outside=join(f.dir,'outside.mjs');await writeFile(outside,'throw Error("must not execute");');
 await symlink(outside,join(f.root,'linked.mjs'));
 for(const path of ['../outside.mjs','./linked.mjs']){await f.save({sample:path});await assert.rejects(connectionExtensions(f.manifest),/inside the runtime/);}
 for(const providers of [{sample:outside},{sample:'./provider.js'},{'../bad':'./provider.mjs'}]){await f.save(providers);await assert.rejects(connectionExtensions(f.manifest),/Invalid connection extension/);}
});
