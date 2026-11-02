// A level change reaches a running agent once. The end-of-turn message states
// the levels of the Roots it lists, but it comes only at the end of a turn and
// never for a Normal Root; so whenever chill hands a conversation something
// (a tool hook, a wake, a message to an idle chat), it compares the levels of
// the Roots the conversation owns with the last ones stated to it and tells it
// of each difference. Those are kept per conversation in
// workspace/levels-told/<owner key>.json, under a lock of their own that takes
// no other, so any caller may hold its locks. A Root seen for the first time is
// recorded, not told: the end-of-turn message or the adopt result states its level.
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {readJson,writeJsonAtomically,withStoreLock} from './storage.mjs';
import {workspaceDirectory} from './goal-store.mjs';
import {validOwner} from './owner.mjs';
import {ownedRootLevels,levelChangeText} from './autonomy.mjs';

const key=owner=>{const {agent,id,context}=validOwner(owner);return createHash('sha256').update(JSON.stringify([agent,id,context??null])).digest('hex');};
const path=owner=>join(workspaceDirectory(),'levels-told',`${key(owner)}.json`);
const locked=(owner,run)=>withStoreLock(join(workspaceDirectory(),'locks',`levels-told-${key(owner)}`),run);
const update=(owner,change)=>locked(owner,async()=>{
  const before=(await readJson(path(owner)))?.levels||{},told={...before};
  const result=await change(told);
  if(Object.keys(told).some(id=>told[id]!==before[id]))await writeJsonAtomically(path(owner),{levels:told});
  return result;
});

// The end-of-turn message stated these Roots' levels (autonomy turnPlan roots).
export const recordLevelsTold=(owner,roots)=>update(owner,told=>{for(const root of roots)told[root.id]=root.level;});

// The notice for each owned Root whose level differs from the one last stated; '' when none.
export async function takeLevelNotice(owner){
  const levels=await ownedRootLevels(owner);
  if(!levels.length)return '';
  return update(owner,told=>{
    const lines=[];
    for(const {root,level} of levels){
      const was=told[root.id];
      if(was!==undefined&&was!==level)lines.push(levelChangeText(root,was,level));
      told[root.id]=level;
    }
    return lines.join('\n');
  });
}
