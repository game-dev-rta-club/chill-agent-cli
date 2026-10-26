import {listGoals} from './extension-api.mjs';
import {agentContinuation} from './agents/index.mjs';
import {MAX_CHECKS_PER_REVISION} from './continuation-monitor.mjs';

// Whether a polled chat keeps the Web server from stopping or updating.
// `active`: the chat's Autonomy asks this Root for end-of-turn checks.
export function continuationKeepsAlive(f,state,active){
 // Active work is protected even when no check is asked for.
 if(f.queue.length||f.heartbeatFresh||f.harnessState==='active'||f.turn&&f.turn.completedAt==null)return true;
 if(f.pendingFeedback.length&&!f.paused)return true;
 if(!f.stable||!['idle','notLoaded','active'].includes(f.harnessState))return true;
 if(!active||f.paused)return false;
 const last=state?.attempts?.at(-1);
 if(last&&!last.completedAt&&!f.pendingWork?.endedAt)return true;
 return state?.revision!==f.revision||(state?.attempts?.length||0)<MAX_CHECKS_PER_REVISION;
}
// The host for end-of-turn checks of agents chill polls (Codex). An agent that
// checks at its own Stop (Claude) needs nothing here. It shows no Web control:
// Autonomy is set per Goal in the comment box.
// continuation = {live, tick?(), busy?(), prepare?()}.
export function createContinuationExtension({roots=async()=>(await listGoals()).filter(g=>!g.parentId),continuation=agentContinuation}={}){
 const ready=new Set();
 async function polled(){
  const list=[];
  for(const root of await roots()){const c=continuation(root);if(c?.tick)list.push([root,c]);}
  return list;
 }
 async function prepare(root,c){if(!ready.has(root.id)){await c.prepare?.();ready.add(root.id);}}
 return {
  id:'continuation',label:'Continuation',
  async start(){for(const [root,c] of await polled())await prepare(root,c);},
  async tick(){for(const [root,c] of await polled()){await prepare(root,c);await c.tick();}},
  async read(){return null;},
  async busy(){
   for(const [,c] of await polled())if(c.busy&&await c.busy())return true;
   return false;
  },
 };
}

export const createExtension=createContinuationExtension;
