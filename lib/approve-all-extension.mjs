// Approve all as a header control next to Auto-continue: the same On/Off in the
// More menu and at the bottom of the Agent menu. Only agents whose prompts a
// hook can answer offer it (Claude); turning it on asks for confirmation first.
import {readGoalContext} from './extension-api.mjs';
import {agentFor} from './agents/index.mjs';

export const approveAllConfirmation={title:'Approve all',message:"The agent's permission prompts in this conversation will be answered with Allow, so unattended work keeps going without asking you. Prompts the agent never lets an automatic answer approve, such as removing critical paths, still ask.",confirmLabel:'Turn on'};
const description='Answers the agent’s permission prompts with Allow.';

export function createApproveAllExtension({context=readGoalContext,agent=agentFor}={}){
 return {
  id:'approve-all',label:'Approve all',
  async read(goalId,{activity=false}={}){
   const {root}=await context(goalId),a=agent(root);
   if(!a?.readApproveAll)return null;
   return {rootId:root.id,enabled:await a.readApproveAll(),placement:'header',icon:'shield',description,confirmOn:approveAllConfirmation,...(activity?{activity:{label:'Approve all',entries:[]}}:{})};
  },
  async set(goalId,{enabled,rootId}){
   const {root}=await context(goalId),a=agent(root);
   if(!a?.setApproveAll)throw Error('Approve all is not available for this agent.');
   if(rootId!==undefined&&rootId!==root.id)throw Error('Agent changed. Refresh to retry.');
   await a.setApproveAll(enabled);
  },
 };
}
export const createExtension=()=>createApproveAllExtension();
