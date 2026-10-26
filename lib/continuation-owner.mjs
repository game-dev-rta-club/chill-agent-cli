// A Root's continuation journal record (workspace/continuation/<rootId>.json)
// names the agent it was written for: its `connection` or its `threadId`. Read
// against the Root's current agent, it is the same agent's, one the agent takes
// over (a continued conversation listed in the Root's `previousConnections`, or
// a record written before any agent worked on the Root), or another agent's,
// which the current agent never sees: for it the record starts over, so its
// Autonomy is Normal. Pure; no I/O.
import {autonomyOf,validAutonomy} from '../public/autonomy.js';

export const sameConnection=(a,b)=>Boolean(a&&b)&&Object.keys({...a,...b}).every(key=>a[key]===b[key]);
export const ownerless=state=>!state?.threadId&&!state?.connection;
// The Root's current agent as journal fields: {threadId}, {connection} or {}.
export const rootOwner=root=>root.threadId?{threadId:root.threadId}:root.connection?{connection:root.connection}:{};
// 'none' (no record), 'same', 'adopted' (taken over, with its state) or 'other'.
export function journalOwnership(root,state){
 if(!state)return 'none';
 if(root.threadId)return state.threadId===root.threadId?'same':ownerless(state)?'adopted':'other';
 if(root.connection){
  if(!state.threadId&&sameConnection(state.connection,root.connection))return 'same';
  return ownerless(state)||!state.threadId&&(root.previousConnections||[]).some(previous=>sameConnection(previous,state.connection))?'adopted':'other';
 }
 return ownerless(state)?'same':'other';
}
// The Root's level for its current agent.
export const journalAutonomy=(root,state)=>['same','adopted'].includes(journalOwnership(root,state))?autonomyOf(state):1;
// The record with `level` set for the Root's current agent, or null when it
// already has it. Another agent's record starts over for the current one, its
// unconfirmed requests closed into history, never resent; a record the agent
// takes over keeps its owner until that agent writes it.
export function withAutonomy(root,state,level,at=new Date().toISOString()){
 if(!validAutonomy(level))throw Error('Autonomy must be Normal, Auto Continue or Ultra Continue.');
 const ownership=journalOwnership(root,state);
 if(ownership==='none')return {rootId:root.id,...rootOwner(root),attempts:[],autonomy:level,updatedAt:at};
 if(ownership!=='other')return autonomyOf(state)===level?null:{...state,autonomy:level,updatedAt:at};
 const closed=(state.attempts||[]).map(a=>a.completedAt?a:{...a,phase:'assignment-changed',completedAt:at});
 return {rootId:root.id,...rootOwner(root),history:[...(state.history||[]),...closed],attempts:[],autonomy:level,updatedAt:at};
}
