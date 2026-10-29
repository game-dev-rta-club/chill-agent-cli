// Autonomy is one value per Root's agent, kept as `autonomy` in the Root's
// continuation journal record, so the record's owner check (continuation-owner)
// makes it per agent: the same or a continued conversation keeps the level,
// another conversation taking the Root starts at Normal, and a level set before
// any agent works on the Root goes to the first one. This is the one reader for
// rules, revisions and the Web.
import {join} from 'node:path';
import {readJson,writeJsonAtomically,withStoreLock} from './storage.mjs';
import {workspaceDirectory,readGoalContext,validId} from './goal-store.mjs';
import {ownerPolicyLock} from './policy-locks.mjs';
import {journalAutonomy,withAutonomy,rootOwner} from './continuation-owner.mjs';
import {recordServerUse} from './server-lifecycle.mjs';
import {dataDirectory} from './data-directory.mjs';

// The journal storage('continuation') reads, by path, since extension-api loads this module.
const journalPath=id=>join(workspaceDirectory(),'continuation',`${validId(id)}.json`);
export const rootAutonomy=async root=>journalAutonomy(root,await readJson(journalPath(root.id)));
// Each Goal with the level of its Root's agent, as the Web shows it.
export async function goalsWithRootAutonomy(goals){
 const byId=new Map(goals.map(g=>[g.id,g])),levels=new Map();
 const rootOf=goal=>{const seen=new Set();while(goal?.parentId&&byId.has(goal.parentId)&&!seen.has(goal.id)){seen.add(goal.id);goal=byId.get(goal.parentId);}return goal;};
 for(const goal of goals){const root=rootOf(goal);if(!root.parentId&&!levels.has(root.id))levels.set(root.id,await rootAutonomy(root));}
 return goals.map(goal=>({...goal,autonomy:levels.get(rootOf(goal).id)??1}));
}
// The lock its agent's end-of-turn check writes the journal under, so a level
// set meanwhile is never lost.
const ownerLock=(root,run)=>{
 if(root.owner)return ownerPolicyLock(root.owner,run);
 return withStoreLock(join(workspaceDirectory(),'locks',`continuation-${validId(root.id)}`),run);
};
// The Web's Autonomy control on any Goal sets its Root's level. Hooks read it
// afresh, so a running agent meets the change at its next hook.
export async function setRootAutonomy(goalId,level){
 const {root}=await readGoalContext(goalId);
 const key=JSON.stringify(rootOwner(root));
 return ownerLock(root,async()=>{
  const {root:now}=await readGoalContext(goalId);
  if(now.id!==root.id||JSON.stringify(rootOwner(now))!==key)throw Error('The Root\'s agent changed. Try again.');
  const next=withAutonomy(now,await readJson(journalPath(now.id)),level);
  if(next){await writeJsonAtomically(journalPath(now.id),next);await recordServerUse(dataDirectory());}
  return {goalId,rootId:now.id,autonomy:level};
 });
}
