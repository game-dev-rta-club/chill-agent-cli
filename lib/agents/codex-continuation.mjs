// The end-of-turn check for a Codex chat: a poller in the Web server watches
// the chat and queues one message when its run ends, as the Autonomy of the
// Roots the chat owns asks (autonomy turnPlan).
import {readMonitor,createMonitorRunner} from '../continuation-monitor.mjs';
import {monitorService} from '../continuation-service.mjs';
import {continuationObservation,enqueueContinuation} from './codex-continuation-observation.mjs';
import {continuationKeepsAlive} from '../continuation-extension.mjs';
import {readTurnPlan} from '../autonomy.mjs';
import {agentKey,goalsHeldElsewhere} from './index.mjs';
import {recordHidden} from '../hidden-failure.mjs';
import {codexThread,codexOwner} from './owners.mjs';

export async function codexTurnPlan(threadId) {
  const plan=await readTurnPlan({owns:goal=>codexThread(goal)===threadId,held:()=>goalsHeldElsewhere(agentKey({owner:codexOwner(threadId)}))});
  return plan&&{...plan,threadId,owner:codexOwner(threadId)};
}

export function codexContinuation(root,{read=readMonitor,plan=()=>codexTurnPlan(codexThread(root)),observe=continuationObservation,enqueue=enqueueContinuation,
  retireLegacy=async id=>{if(process.platform==='darwin')await monitorService(id,'stop');}}={}) {
  const threadId=codexThread(root);
  const tick=createMonitorRunner({plan:()=>plan()});
  return {
    live:true,
    // A reassigned chat never exposes a previous owner's continuation history.
    async read(){const state=await read(root.id);return state?.owner?.agent==='codex'&&state.owner.id===threadId?state:null;},
    plan,
    // Facts for the policy layer, and the one queued request it may send.
    observe:pending=>observe(root.id,pending),
    enqueue:(facts,text,id)=>enqueue(facts,text,id),
    prepare:()=>retireLegacy(root.id),
    tick:()=>tick(root.id),
    async busy(){
      const state=await read(root.id);
      // A failed observation is not proof that work has stopped.
      try{return continuationKeepsAlive(await observe(root.id,state?.attempts?.at(-1)),state,(await plan())?.rootId===root.id);}catch(error){recordHidden('codex-continuation.busy',error);return true;}
    },
  };
}
