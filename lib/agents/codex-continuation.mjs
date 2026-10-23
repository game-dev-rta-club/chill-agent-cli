// AutoContinue for a Codex chat: a poller in the Web server watches the chat
// and queues a continuation request when its run ends.
import {readMonitor,configureMonitor,tickMonitor} from '../continuation-monitor.mjs';
import {monitorService} from '../continuation-service.mjs';
import {continuationObservation,enqueueContinuation} from './codex-continuation-observation.mjs';
import {readRunOutput} from './codex-run-output.mjs';
import {continuationKeepsAlive} from '../continuation-extension.mjs';
import {recordHidden} from '../hidden-failure.mjs';

export function codexContinuation(root,{read=readMonitor,configure=configureMonitor,tick=tickMonitor,observe=continuationObservation,enqueue=enqueueContinuation,output=readRunOutput,
  retireLegacy=async id=>{if(process.platform==='darwin')await monitorService(id,'stop');}}={}) {
  const threadId=root.threadId;
  return {
    live:true,
    // A reassigned chat never exposes a previous owner's continuation history.
    async read(){const state=await read(root.id);return state?.threadId===threadId?state:null;},
    // Facts for the policy layer, and the one queued request it may send.
    observe:pending=>observe(root.id,pending),
    enqueue:(facts,text,id)=>enqueue(facts,text,id),
    prepare:()=>retireLegacy(root.id),
    configure:enabled=>configure(root.id,enabled),
    tick:()=>tick(root.id),
    async busy(){
      const state=await read(root.id);
      // A failed observation is not proof that work has stopped.
      try{return continuationKeepsAlive(await observe(root.id,state?.attempts?.at(-1)),state);}catch(error){recordHidden('codex-continuation.busy',error);return true;}
    },
    async runOutput(attempt){
      let work=attempt.work||null,error=null;
      if(!work?.endedAt){
        try{work=await output({threadId,id:attempt.id,at:attempt.at,turnId:attempt.turnId})||work;}
        catch(e){recordHidden('codex-continuation.output',e);error='Updates unavailable. Saved output is kept.';}
      }
      return {work,error};
    },
  };
}
