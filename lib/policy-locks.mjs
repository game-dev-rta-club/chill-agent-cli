import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {withStoreLock} from './storage.mjs';
import {workspaceDirectory,validThreadId} from './goal-store.mjs';

// Serializes a polled chat's policy journal (Codex).
export const policyLock=(thread,run)=>withStoreLock(join(workspaceDirectory(),'locks',`policy-${validThreadId(thread)}`),run);
// The lock a Root owner's end-of-turn check writes its journal under: by its
// context when it has one, otherwise by its conversation ID.
export const ownerPolicyLock=(owner,run)=>owner.context?connectionPolicyLock({sessionId:owner.id,contextId:owner.context},run):policyLock(owner.id,run);
// Serializes a policy journal for one bound conversation context.
export function connectionPolicyLock(connection,run){
 if(!connection||typeof connection!=='object'||typeof connection.sessionId!=='string'||!connection.sessionId)throw Error('Invalid native connection.');
 validThreadId(connection.contextId);
 const key=createHash('sha256').update(JSON.stringify([connection.sessionId,connection.contextId])).digest('hex');
 return withStoreLock(join(workspaceDirectory(),'locks',`native-policy-${key}`),run);
}
