// Moves of data an earlier version wrote run until each has finished once in
// this workspace, recorded by name in workspace/migrations.json, so a migrated
// workspace never looks for old shapes again. A move must be safe to repeat:
// two processes may both run it before either records it.
import {join} from 'node:path';
import {readJson,writeJsonAtomically} from './storage.mjs';
import {dataDirectory} from './data-directory.mjs';

const path=()=>join(dataDirectory(),'workspace','migrations.json');
const finished=async()=>(await readJson(path()))?.done??[];
export async function once(name,run){
  if((await finished()).includes(name))return;
  await run();
  const done=await finished();
  if(!done.includes(name))await writeJsonAtomically(path(),{done:[...done,name]});
}
