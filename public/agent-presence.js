import {isRunning} from './goal-state.js';
const labels={working:'Running',idle:'Idle',paused:'Paused',unknown:'Status unavailable',unlinked:'Not connected'};
const displayState=status=>isRunning(status)?'working':status;
export const presenceLabel=status=>labels[displayState(status)]||labels.unknown;
export function presenceMark(status){
 status=displayState(status);
 const state=Object.hasOwn(labels,status)?status:'unknown';
 const shape=state==='paused'?'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 4v8m6-8v8"/></svg>':state==='unknown'?'<span aria-hidden="true">?</span>':'<span class="dot" aria-hidden="true"></span>';
 return `<span class="status ${state}" aria-hidden="true">${shape}</span>`;
}
export function createAgentPresence({button,getGoalId}){
 let request=0,controller=null,busy=false,routeGoalId=null;
 const tooltip=document.getElementById('agent-tooltip');
 function render(data){
  const status=displayState(data.status)||'unknown';button.dataset.state=status;button.removeAttribute('title');
  if(tooltip){tooltip.replaceChildren(document.createTextNode(`Agent · ${presenceLabel(status)}`));const hint=document.createElement('small');hint.textContent='Activity, settings, and usage.';tooltip.append(hint);}
  window.dispatchEvent(new CustomEvent('chill-agent-presence',{detail:{routeGoalId:getGoalId(),...data}}));
 }
 async function refresh(){
  const id=getGoalId();if(!id||busy||document.visibilityState==='hidden')return;
  const token=++request;controller=new AbortController();busy=true;
  try{const response=await fetch(`/api/goals/${id}/agent/presence`,{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])});if(!response.ok)throw Error();const data=await response.json();if(token===request&&id===getGoalId())render(data);}
  catch(error){if(error.name!=='AbortError'&&token===request&&id===getGoalId())render({status:'unknown'});}
  finally{if(token===request)busy=false;}
 }
 render({status:'unknown'});
 const timer=setInterval(refresh,2000);
 window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
 return {refresh,routeChanged(){const id=getGoalId();if(id===routeGoalId){void refresh();return;}routeGoalId=id;request++;controller?.abort();busy=false;render({status:'unknown'});void refresh();},destroy(){clearInterval(timer);controller?.abort();window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);}};
}
