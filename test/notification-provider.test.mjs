import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, copyFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

test('an absent provider permits legacy settings; a configured broken provider never does', async t=>{
  const root=await mkdtemp(join(tmpdir(),'chill-provider-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'lib'));
  const loader=join(root,'lib/notification-provider.mjs');
  await copyFile(new URL('../lib/notification-provider.mjs',import.meta.url),loader);
  for(const name of ['project-workspace.mjs','data-directory.mjs','storage.mjs'])await copyFile(new URL('../lib/'+name,import.meta.url),join(root,'lib',name));
  let revision=0;
  const load=async()=> (await import(pathToFileURL(loader).href+'?test='+revision++)).notificationProvider();
  assert.equal(await load(),null);
  await writeFile(join(root,'extensions.json'),JSON.stringify({notificationProvider:'./missing.mjs'}));
  await assert.rejects(load(),/Cannot find module/);
  await writeFile(join(root,'invalid.mjs'),'export const notifications = {};');
  await writeFile(join(root,'extensions.json'),JSON.stringify({notificationProvider:'./invalid.mjs'}));
  await assert.rejects(load(),/missing settings/);
  await writeFile(join(root,'valid.mjs'),'export const notifications = {settings(){return {enabled:false};},configure(){},prepare(){},result(){}};');
  await writeFile(join(root,'extensions.json'),JSON.stringify({notificationProvider:'./valid.mjs'}));
  assert.deepEqual((await load()).settings(),{enabled:false});
});
