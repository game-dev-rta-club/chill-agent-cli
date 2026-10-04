const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const period=m=>m===null?'Usage':m%1440===0?`${m/1440}d`:m%60===0?`${m/60}h`:`${m}m`;
const date=seconds=>new Intl.DateTimeFormat('en-US',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',timeZoneName:'short'}).format(new Date(seconds*1000));
export function extensionMarkup(controls){return controls?.length?`<section class="agent-section agent-extensions">${controls.map(c=>`<label class="agent-extension"><span>${esc(c.label)}</span><input type="checkbox" role="switch" data-extension="${esc(c.id)}" ${c.enabled?'checked':''} aria-label="${esc(c.label)}"></label>`).join('')}<p class="agent-muted" data-extension-message role="status"></p></section>`:'';}
function settingsMarkup(data){
 const s=data.settings;
 if(!data.capabilities?.settings||!data.models?.length)return `<dl class="agent-settings" aria-label="Settings"><div><dt>Model</dt><dd>${esc(s?.label||'Unavailable')}</dd></div><div><dt>Reasoning</dt><dd>${esc(s?.reasoning||'Unavailable')}</dd></div></dl>`;
 return `<form data-agent-settings><label>Model<select name="model" aria-label="Model">${data.models.map(m=>`<option value="${esc(m.id)}" ${m.id===s.model?'selected':''}>${esc(m.label)}</option>`).join('')}</select></label><label>Reasoning<select name="effort" aria-label="Reasoning"></select></label><p class="agent-muted" data-settings-message role="status"></p></form>`;
}
export function agentMarkup(data) {
 if(!data.connected)return '<p class="agent-empty">No agent connected.</p>';
 const settings=data.settings,work=data.work,queue=data.queue;
 const workText=work?.status==='working'?'Running':work?.status==='paused'?'Paused':work?.status==='idle'?'Idle':'Status unavailable';
 return `<section class="agent-section">${settingsMarkup(data)}</section>
 <section class="agent-section"><h3>Activity</h3><div class="agent-current"><span class="agent-run-state" data-state="${esc(work?.status||'unknown')}">${esc(workText)}</span>${work?.goalId&&['working','paused'].includes(work.status)?`<a class="agent-work-link" href="#/goal/${work.goalId}">#${work.goalId} ${esc(work.title)} →</a>`:''}</div>

 <div class="agent-pending"><span class="agent-muted">Queue${queue?` · ${queue.items.length}${queue.truncated?'+':''}`:''}</span>${queue?queue.items.length?`<ol class="agent-queue">${queue.items.map(q=>`<li>${q.goalId?`<a href="#/goal/${q.goalId}">#${q.goalId} ${esc(q.title)}</a>`:esc(q.title)}</li>`).join('')}</ol>`:'':'<p>Queue unavailable.</p>'}</div></section>
 <section class="agent-section"><h3 title="Shared across your Codex account">Usage</h3>${data.usage===null?'<p>Usage unavailable.</p>':data.usage.flatMap(bucket=>bucket.windows.map(w=>`<div class="agent-window"><div class="agent-usage-label"><span>${esc(bucket.name)} · ${period(w.minutes)}</span><strong>${w.remaining===null?'Unavailable':`${Math.round(w.remaining)}% left`}</strong></div>${w.remaining===null?'':`<progress max="100" value="${w.remaining}" aria-label="${esc(bucket.name)} ${Math.round(w.remaining)}% left"></progress>`}<p class="agent-muted">${w.resetAt===null?'Reset time unavailable':`Resets ${date(w.resetAt)}`}</p></div>`)).join('')||'<p>No usage data.</p>'}</section>
 `;
}
export function createAgentMenu({button,panel,content,getGoalId}) {
 let opened=false,request=0,controller=null,timer=null,focusBefore=null,current=null,saving=false;
 const refreshButton=panel.querySelector('[data-agent-refresh]');
 function render(data){
  current=data;content.innerHTML=agentMarkup(data)+extensionMarkup(data.extensions?.filter(c=>c.placement!=='header'));
  const form=content.querySelector('[data-agent-settings]');if(!form)return;
  const model=form.elements.model,effort=form.elements.effort;
  function options(){const m=data.models.find(m=>m.id===model.value);const previous=effort.value||data.settings.reasoning;effort.innerHTML=m.efforts.map(e=>`<option value="${esc(e)}">${esc(e)}</option>`).join('');effort.value=m.efforts.includes(previous)?previous:m.defaultEffort||m.efforts[0];}
  options();model.addEventListener('change',options);
 }
 content.addEventListener('submit',event=>event.preventDefault());
 content.addEventListener('change',async event=>{
  if(event.target.matches('[data-extension]')){
   if(saving)return;
   const id=getGoalId(),data=current,control=data.extensions.find(c=>c.id===event.target.dataset.extension);
   const enabled=event.target.checked,token=++request;controller?.abort();saving=true;
   content.querySelectorAll('input,select').forEach(el=>el.disabled=true);refreshButton.disabled=true;
   try{
    const response=await fetch(`/api/goals/${id}/extensions/${control.id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled,rootId:control.rootId}),signal:AbortSignal.timeout(30000)});
    const result=await response.json();if(!response.ok)throw Error(result.error||'Could not save.');
    if(opened&&token===request&&id===getGoalId()){render({...data,extensions:result});content.querySelector(`[data-extension="${control.id}"]`)?.focus({preventScroll:true});}
   }catch(error){if(opened&&token===request&&id===getGoalId()){render(data);content.querySelector('[data-extension-message]').textContent=error.name==='TimeoutError'?'Save unconfirmed. Refresh to check.':error.message;}}
   finally{saving=false;refreshButton.disabled=false;if(opened&&token!==request)void refresh();}
   return;
  }
  const form=event.target.closest('[data-agent-settings]');if(!form||saving)return;
  const focusName=event.target.name;
  const id=getGoalId(),data=current;
  const input={threadId:data.threadId,model:form.elements.model.value,effort:form.elements.effort.value,expected:{model:data.settings.model,effort:data.settings.reasoning}};
  if(input.model===data.settings.model&&input.effort===data.settings.reasoning)return;
  const token=++request;controller?.abort();saving=true;
  content.querySelectorAll('input,select').forEach(el=>el.disabled=true);
  refreshButton.disabled=true;form.querySelector('[data-settings-message]').textContent='Saving…';
  try{const response=await fetch(`/api/goals/${id}/agent`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(30000)});const result=await response.json();if(!response.ok)throw Error(result.error||'Could not save.');if(opened&&token===request&&id===getGoalId()){render({...result,extensions:data.extensions});const message=content.querySelector('[data-settings-message]');if(message)message.textContent='Saved';if(document.activeElement===document.body||form.contains(document.activeElement))content.querySelector(`[name="${focusName}"]`)?.focus({preventScroll:true});}}
  catch(error){if(opened&&token===request&&id===getGoalId()){render(data);content.querySelector('[data-settings-message]').textContent=error.name==='TimeoutError'?'Save unconfirmed. Refresh to check.':error.message;}}
  finally{saving=false;for(const el of form.elements)el.disabled=false;refreshButton.disabled=false;content.removeAttribute('aria-busy');if(opened&&token!==request)void refresh();}
 });
 async function refresh(){
  const id=getGoalId();if(!opened||!id||saving)return;
  const token=++request;controller?.abort();controller=new AbortController();
  refreshButton.disabled=true;content.setAttribute('aria-busy','true');
  try{const options={signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]),cache:'no-store'};const [response,extensionResponse]=await Promise.all([fetch(`/api/goals/${id}/agent`,options),fetch(`/api/goals/${id}/extensions`,options)]);if(!response.ok||!extensionResponse.ok)throw new Error();const data=await response.json();data.extensions=await extensionResponse.json();
   if(!opened||token!==request||id!==getGoalId())return;
   // Do not replace a focused link during an automatic refresh.
   if(!content.contains(document.activeElement))render(data);
  }catch(error){if(error.name!=='AbortError'&&opened&&token===request)content.innerHTML='<p class="agent-empty">Agent unavailable. Refresh to retry.</p>';}
  finally{if(token===request){refreshButton.disabled=false;content.removeAttribute('aria-busy');}}
 }
 function close({restore=false}={}){if(!opened)return;opened=false;request++;controller?.abort();clearInterval(timer);panel.hidden=true;button.setAttribute('aria-expanded','false');if(restore)(focusBefore?.isConnected?focusBefore:button).focus({preventScroll:true});}
 function open(){if(!getGoalId())return;opened=true;focusBefore=document.activeElement;panel.hidden=false;button.setAttribute('aria-expanded','true');content.innerHTML='<p class="agent-empty">Loading…</p>';panel.querySelector('[data-agent-close]').focus({preventScroll:true});void refresh();timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh();},60000);}
 button.addEventListener('click',()=>opened?close({restore:true}):open());
 panel.querySelector('[data-agent-close]').addEventListener('click',()=>close({restore:true}));refreshButton.addEventListener('click',refresh);
 document.addEventListener('pointerdown',e=>{if(opened&&!panel.contains(e.target)&&!button.contains(e.target))close();});
 document.addEventListener('focusin',e=>{if(opened&&!panel.contains(e.target)&&!button.contains(e.target))close();});
 document.addEventListener('keydown',e=>{if(opened&&e.key==='Escape'){e.preventDefault();close({restore:true});}});
 panel.addEventListener('click',e=>{if(e.target.closest('a'))close({restore:true});});
 window.addEventListener('blur',()=>setTimeout(()=>{if(opened&&document.activeElement?.tagName==='IFRAME')close();},0));
 document.addEventListener('visibilitychange',()=>{if(opened&&document.visibilityState==='visible')void refresh();});
 return {routeChanged(){close();button.hidden=!getGoalId();},close};
}
