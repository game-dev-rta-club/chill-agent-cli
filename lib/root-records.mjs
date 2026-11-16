// What a Root keeps by its ID, apart from its Goals: its comment hand-off, its
// Autonomy and continuation journal, its look and its notifications. A Root
// moved under another Goal drops them, so its Goals follow the destination
// Root, and if it becomes a Root again it starts from the defaults.
import {unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {workspaceDirectory,validId} from './goal-store.mjs';
import {readWorkspaceTheme,saveWorkspaceTheme} from './workspace-theme.mjs';

const remove=path=>unlink(path).catch(error=>{if(error.code!=='ENOENT')throw error;});
export async function forgetRoot(id) {
  validId(id);
  for(const folder of ['hand-off','continuation'])await remove(join(workspaceDirectory(),folder,`${id}.json`));
  if((await readWorkspaceTheme()).roots[id])await saveWorkspaceTheme({rootId:id,reset:true});
  // The notification extensions keep a Root's choice in their own store.
  const {storage}=await import('./extension-api.mjs');
  for(const namespace of ['notifications','web-notifications']){
    const store=storage(namespace);
    await store.lock('1',async()=>{const s=await store.read('1');if(s?.roots?.[id]){delete s.roots[id];await store.write('1',s);}});
  }
}
