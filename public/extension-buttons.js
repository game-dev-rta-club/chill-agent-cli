const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const repeatIcon=`<svg class="monitor-logo" viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="coffee-fill" d="M7 15h19v9a8 8 0 0 1-8 8h-3a8 8 0 0 1-8-8z"/><path d="M26 17h2a4 4 0 0 1 0 8h-2"/><path class="coffee-steam" d="M13 11c-4-4 4-5 0-9m8 9c-4-4 4-5 0-9"/></svg>`;
export const extensionIcon=icon=>icon==='repeat'?repeatIcon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M8 12h8"/></svg>';
export function createExtensionButtons({container,getGoalId,announce=()=>{}}){
 let controls=[],generation=0,controller=null,saving=false;
 function render(unknown=false){
  const focus=document.activeElement?.dataset?.headerExtension;
  const markup=controls.filter(c=>c.placement==='header').map(c=>`<span class="extension-control"><button type="button" class="extension-trigger" data-header-extension="${esc(c.id)}" aria-label="${esc(c.label)}" aria-describedby="extension-tip-${esc(c.id)}" ${unknown?'':`aria-pressed="${c.enabled}"`} title="${esc(c.label)}：${unknown?'Status unavailable':c.enabled?'ON · Turn off':'OFF · Turn on'}" ${saving||unknown?'disabled':''}>${extensionIcon(c.icon)}</button><span class="extension-tooltip" role="tooltip" id="extension-tip-${esc(c.id)}">${esc(c.label)} · ${unknown?'Unavailable':c.enabled?'ON':'OFF'}<small>Prompts the agent to keep going.</small></span></span>`).join('');
  const template=document.createElement('template');template.innerHTML=markup;
  const retained=new Set();
  for(const fresh of template.content.children){
   const next=fresh.querySelector('button'),id=next.dataset.headerExtension;
   const current=container.querySelector(`[data-header-extension="${id}"]`);
   if(!current){container.append(fresh.cloneNode(true));retained.add(id);continue;}
   // Preserve the pressed pointer target through polling/focus refreshes.
   for(const attr of [...current.attributes])if(!next.hasAttribute(attr.name))current.removeAttribute(attr.name);
   for(const attr of next.attributes)if(current.getAttribute(attr.name)!==attr.value)current.setAttribute(attr.name,attr.value);
   const icon=current.querySelector('svg'),nextIcon=next.querySelector('svg');
   if(!icon.isEqualNode(nextIcon))icon.replaceWith(nextIcon.cloneNode(true));
   const tip=current.parentElement.querySelector('[role="tooltip"]'),nextTip=fresh.querySelector('[role="tooltip"]');
   if(!tip.isEqualNode(nextTip))tip.replaceWith(nextTip.cloneNode(true));
   retained.add(id);
  }
  for(const button of container.querySelectorAll('[data-header-extension]'))if(!retained.has(button.dataset.headerExtension))button.parentElement.remove();
  if(focus)container.querySelector(`[data-header-extension="${focus}"]`)?.focus({preventScroll:true});
 }
 async function refresh(){
  const id=getGoalId();if(!id||saving)return;
  const token=++generation;controller?.abort();controller=new AbortController();
  try{const response=await fetch(`/api/goals/${id}/extensions`,{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])});if(!response.ok)throw Error();const data=await response.json();if(token!==generation||id!==getGoalId())return;controls=data;render();}
  catch(error){if(error.name!=='AbortError'&&token===generation&&id===getGoalId())render(true);}
 }
 container.addEventListener('click',async event=>{
  const button=event.target.closest('[data-header-extension]');if(!button||saving)return;
  const id=getGoalId(),control=controls.find(c=>c.id===button.dataset.headerExtension);if(!control)return;
  const token=++generation;controller?.abort();saving=true;render();
  try{const response=await fetch(`/api/goals/${id}/extensions/${control.id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rootId:control.rootId,enabled:!control.enabled}),signal:AbortSignal.timeout(30000)});const result=await response.json();if(!response.ok)throw Error(result.error||'Could not save.');if(token===generation&&id===getGoalId()){controls=result;announce(`${control.label}: ${!control.enabled?'ON':'OFF'}`);window.dispatchEvent(new CustomEvent('chill-extensions-changed'));}}
  catch(error){if(token===generation&&id===getGoalId())announce(error.name==='TimeoutError'?'Save unconfirmed. Refreshing…':error.message);}
  finally{saving=false;if(token===generation&&id===getGoalId())render();void refresh();}
 });
 const timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh();},15000);
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void refresh();});
 window.addEventListener('focus',refresh);
 window.addEventListener('chill-extensions-changed',refresh);
 return {routeChanged(){generation++;controller?.abort();controls=[];render();void refresh();},refresh,destroy(){clearInterval(timer);controller?.abort();window.removeEventListener('chill-extensions-changed',refresh);}};
}
