// A Root's continuation journal record (workspace/continuation/<rootId>.json)
// names the owner it was written for. Read against the Root's current owner, it
// is the same owner's, one the owner takes over (a record of an owner listed in
// the Root's previousOwners, or one written before any owner), or another
// owner's, which the current owner never sees: for it the record starts over,
// so its Autonomy is Normal. Pure; no I/O.
import {autonomyOf,validAutonomy} from '../public/autonomy.js';
import {sameOwner} from './owner.mjs';

export const ownerless=state=>!state?.owner;
// The Root's current owner as journal fields: {owner} or {}.
export const rootOwner=root=>root.owner?{owner:root.owner}:{};
// 'none' (no record), 'same', 'adopted' (taken over, with its state) or 'other'.
export function journalOwnership(root,state){
 if(!state)return 'none';
 if(!root.owner)return ownerless(state)?'same':'other';
 if(sameOwner(state.owner,root.owner))return 'same';
 return ownerless(state)||(root.previousOwners||[]).some(previous=>sameOwner(previous,state.owner))?'adopted':'other';
}
// The Root's level for its current owner.
export const journalAutonomy=(root,state)=>['same','adopted'].includes(journalOwnership(root,state))?autonomyOf(state):1;
// The record with `level` set for the Root's current owner, or null when it
// already has it. Another owner's record starts over for the current one, its
// unconfirmed requests closed into history, never resent; a record the owner
// takes over keeps its owner until that owner writes it.
export function withAutonomy(root,state,level,at=new Date().toISOString()){
 if(!validAutonomy(level))throw Error('Autonomy must be Normal, Auto Continue or Ultra Continue.');
 const ownership=journalOwnership(root,state);
 if(ownership==='none')return {rootId:root.id,...rootOwner(root),attempts:[],autonomy:level,updatedAt:at};
 if(ownership!=='other')return autonomyOf(state)===level?null:{...state,autonomy:level,updatedAt:at};
 const closed=(state.attempts||[]).map(a=>a.completedAt?a:{...a,phase:'assignment-changed',completedAt:at});
 return {rootId:root.id,...rootOwner(root),history:[...(state.history||[]),...closed],attempts:[],autonomy:level,updatedAt:at};
}
