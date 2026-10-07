import {sqliteLockLocation,withSqliteLease} from './sqlite-leases.mjs';
import { mkdir, readFile, readdir, link, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export async function writeJsonAtomically(path, value, exclusive = false) {
  await mkdir(dirname(path), {recursive:true});
  const temporary = join(dirname(path), `.pending-${randomUUID()}`);
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {flag:'wx',mode:0o600});
  try { if (exclusive) await link(temporary,path); else await rename(temporary,path); }
  finally { await unlink(temporary).catch(error => { if(error.code !== 'ENOENT') throw error; }); }
}
export async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path,'utf8')); }
  catch(error) { if(error.code === 'ENOENT') return fallback; throw error; }
}
export async function numberedFiles(directory, pattern) {
  try { return (await readdir(directory)).flatMap(name => pattern.exec(name)?.[1] || []).map(Number).sort((a,b)=>a-b); }
  catch(error) { if(error.code === 'ENOENT') return []; throw error; }
}
// Numbered leases avoid deleting another process's lock during crash recovery.
export async function withStoreLock(directory, run, options={}) {
  const location=sqliteLockLocation(directory);
  if(location){
    // A previous runtime may still own a numbered lease. Do not silently mix protocols.
    if((await numberedFiles(directory,/^([1-9][0-9]*)\.json$/)).length)throw Error('Legacy leases in a SQLite workspace require offline reconciliation.');
    return withSqliteLease(location,run,options);
  }
  await mkdir(directory,{recursive:true});
  const deadline=Date.now()+(options.timeoutMs??10000);
  while(Date.now()<deadline) {
    const latest=(await numberedFiles(directory,/^([1-9][0-9]*)\.json$/)).at(-1)||0;
    const owner=latest ? await readJson(join(directory,`${latest}.json`)) : null;
    let alive=false;
    if(owner&&!owner.released) { try { process.kill(owner.pid,0); alive=true; } catch(error) { alive=error.code==='EPERM'; } }
    if(alive) { await delay(20); continue; }
    const path=join(directory,`${latest+1}.json`);
    try { await writeJsonAtomically(path,{pid:process.pid,released:false},true); }
    catch(error) { if(error.code==='EEXIST') continue; throw error; }
    try { return await run(); }
    finally { await writeJsonAtomically(path,{pid:process.pid,released:true}); }
  }
  throw new Error(options.message??'Store is busy. Try again.');
}
