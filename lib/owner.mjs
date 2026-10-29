// A Root's owner is the agent conversation that answers its Goals:
// {agent, id} with the agent's name and its own conversation ID, the same shape
// for every agent. An agent may add a context, as Claude does so that a cleared
// conversation keeping its session ID does not inherit its Roots. Each adapter
// reads and builds its own owners (agents/owners.mjs).
const plain=value=>typeof value==='string'&&value.trim()&&value.length<=512&&!/[\x00-\x1f\x7f]/.test(value);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validOwner(owner) {
  if(!owner||typeof owner!=='object'||!/^[a-z][a-z0-9-]{0,39}$/.test(owner.agent??'')||!plain(owner.id))throw Error('Invalid conversation identity.');
  if(owner.context!==undefined&&!uuid.test(owner.context))throw Error('Invalid conversation identity.');
  return {agent:owner.agent,id:owner.id,...(owner.context!==undefined?{context:owner.context}:{})};
}
export const sameOwner=(a,b)=>Boolean(a&&b)&&a.agent===b.agent&&a.id===b.id&&(a.context??null)===(b.context??null);
