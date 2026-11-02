// A conversation's end-of-turn checks (workspace/turn-checks/<owner key>.json):
// the requests Autonomy asked for, the revision each was for and the last
// observation. One record per conversation, however many Roots it owns; each
// Root's Autonomy level stays in its own journal (root-autonomy). Read and write
// it under the owner's policy lock (policy-locks).
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {readJson,writeJsonAtomically} from './storage.mjs';
import {workspaceDirectory,validId,listGoals} from './goal-store.mjs';
import {validOwner,sameOwner,ownsRoot} from './owner.mjs';

const key=owner=>{const {agent,id,context}=validOwner(owner);return createHash('sha256').update(JSON.stringify([agent,id,context??null])).digest('hex');};
const path=owner=>join(workspaceDirectory(),'turn-checks',`${key(owner)}.json`);
const journalPath=id=>join(workspaceDirectory(),'continuation',`${validId(id)}.json`);
export const writeTurnCheck=(owner,record)=>writeJsonAtomically(path(owner),record);
// The record, or for a conversation without one yet, the one its Roots'
// journals kept before checks moved here (seedTurnCheck). Nothing reads those
// journals' check fields after that, so they stay as they are.
export async function readTurnCheck(owner){
 const stored=await readJson(path(owner));
 if(stored)return stored;
 const journals=[];
 for(const root of (await listGoals()).filter(ownsRoot(owner))){const journal=await readJson(journalPath(root.id));if(sameOwner(journal?.owner,owner))journals.push(journal);}
 return seedTurnCheck(owner,journals,new Date().toISOString());
}
const latest=journal=>Math.max(0,...[journal.checkedAt,journal.updatedAt,journal.attempts?.at(-1)?.at].map(at=>Date.parse(at)||0));
// The latest check carries on, with its revision and attempts, so the update
// asks no extra check; the other Roots' attempts go to history, unconfirmed
// ones closed and never resent. Pure.
export function seedTurnCheck(owner,journals,at){
 const [last,...rest]=[...journals].sort((a,b)=>latest(b)-latest(a));
 const record={owner:validOwner(owner),attempts:[],history:[]};
 if(!last)return record;
 const closed=journal=>(journal.attempts||[]).map(a=>a.completedAt?a:{...a,phase:'superseded',completedAt:at});
 return {...record,revision:last.revision??null,attempts:last.attempts||[],history:[last,...rest].flatMap(j=>j.history||[]).concat(rest.flatMap(closed)),
  ...(last.status?{status:last.status}:{}),...(last.checkedAt?{checkedAt:last.checkedAt}:{})};
}
