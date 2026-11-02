// The end-of-turn check for a Codex chat: a poller in the Web server watches
// the chat and queues one message when its run ends, as the Autonomy of the
// Roots the chat owns asks (autonomy turnPlan). Every Root of the chat gives the
// same check, under one key, so the poller runs it once per chat.
import {createMonitorRunner} from '../continuation-monitor.mjs';
import {readTurnCheck} from '../turn-checks.mjs';
import {monitorService} from '../continuation-service.mjs';
import {continuationObservation,enqueueContinuation} from './codex-continuation-observation.mjs';
import {continuationKeepsAlive} from '../continuation-extension.mjs';
import {readTurnPlan} from '../autonomy.mjs';
import {agentKey,goalsHeldElsewhere} from './index.mjs';
import {recordHidden} from '../hidden-failure.mjs';
import {once} from '../one-time.mjs';
import {codexThread,codexOwner} from './owners.mjs';

export async function codexTurnPlan(threadId) {
  const plan=await readTurnPlan({owner:codexOwner(threadId),held:()=>goalsHeldElsewhere(agentKey({owner:codexOwner(threadId)}))});
  return plan&&{...plan,threadId,owner:codexOwner(threadId)};
}

export function codexContinuation(root,{read=readTurnCheck,plan=()=>codexTurnPlan(codexThread(root)),observe=continuationObservation,enqueue=enqueueContinuation,
  retireLegacy=async id=>{if(process.platform==='darwin')await monitorService(id,'stop');}}={}) {
  const threadId=codexThread(root),owner=codexOwner(threadId);
  const tick=createMonitorRunner({plan:()=>plan()});
  return {
    live:true,
    key:`codex:${threadId}`,
    // The chat's own record: another chat's check is kept apart.
    read:()=>read(owner),
    plan,
    // Facts for the policy layer, and the one queued request it may send.
    observe:pending=>observe(root.id,pending),
    enqueue:(facts,text,id)=>enqueue(facts,text,id),
    // The launchd monitor an earlier version installed per Root, stopped once.
    prepare:()=>once(`codex-monitor-service-${root.id}`,()=>retireLegacy(root.id)),
    tick:()=>tick(),
    async busy(){
      const state=await read(owner),planned=await plan();
      // A failed observation is not proof that work has stopped.
      try{return continuationKeepsAlive(await observe(planned?.rootId??root.id,state?.attempts?.at(-1)),state,Boolean(planned));}catch(error){recordHidden('codex-continuation.busy',error);return true;}
    },
  };
}
