import {presenceMark,presenceLabel} from './agent-presence.js';
import {extensionIcon} from './extension-buttons.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const period=m=>m===null?'Usage':m%1440===0?`${m/1440}d`:m%60===0?`${m/60}h`:`${m}m`;
const date=seconds=>new Intl.DateTimeFormat('en-US',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',timeZoneName:'short'}).format(new Date(seconds*1000));
export function extensionMarkup(controls){return controls?.length?`<section class="agent-section agent-extensions">${controls.map(c=>`<label class="agent-extension"><span>${esc(c.label)}</span><input type="checkbox" role="switch" data-extension="${esc(c.id)}" ${c.enabled?'checked':''} aria-label="${esc(c.label)}"></label>`).join('')}<p class="agent-muted" data-extension-message role="status"></p></section>`:'';}
function settingsMarkup(data){
 const s=data.settings;
 if(!data.capabilities?.settings||!data.models?.length)return `<dl class="agent-settings" aria-label="Settings"><div><dt>Model</dt><dd>${esc(s?.label||'Unavailable')}</dd></div><div><dt>Reasoning</dt><dd>${esc(s?.reasoning||'Unavailable')}</dd></div></dl>`;
 return `<form data-agent-settings><label>Model<select name="model" aria-label="Model">${data.models.map(m=>`<option value="${esc(m.id)}" ${m.id===s.model?'selected':''}>${esc(m.label)}</option>`).join('')}</select></label><label>Reasoning<select name="effort" aria-label="Reasoning"></select></label><p class="agent-muted" data-settings-message role="status"></p></form>`;
}
function timeMarkup(at){
 const value=new Date(at);return Number.isNaN(value.getTime())?'':`<time datetime="${esc(at)}" title="${esc(value.toLocaleString())}">${esc(value.toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}))}</time>`;
}
function workMarkup(work){return `<span class="agent-run-state">${presenceMark(work?.status)}${presenceLabel(work?.status)}</span>${work?.goalId&&['working','paused'].includes(work.status)?`<a class="agent-work-link" href="#/goal/${esc(work.goalId)}">#${esc(work.goalId)} ${esc(work.title)} →</a>`:''}`;}
function entryMarkup(entry,id){return `<article class="agent-auto-entry"><div class="agent-auto-meta">${timeMarkup(entry.at)}<span>${esc(entry.result?.label||entry.status)}</span></div><p>${esc(entry.summary)}</p>${entry.message?`<details data-agent-detail="${esc(id)}"><summary>View message</summary><pre class="agent-auto-message">${esc(entry.message)}</pre></details>`:'<p class="agent-muted">Message not saved.</p>'}</article>`;}
export function activityMarkup(controls){
 return (controls||[]).filter(c=>c.activity).map(c=>{
  const a=c.activity,entries=a.entries||[],activeCount=Number.isInteger(a.activeCount)&&a.activeCount>=0?a.activeCount:null;
  return `<section class="agent-section agent-auto"><div class="agent-section-heading"><h3>${esc(a.label||c.label)}${activeCount===null?'':` <span class="agent-count" title="Active checks">${activeCount}</span>`}</h3><button type="button" class="extension-trigger agent-auto-toggle" data-agent-extension="${esc(c.id)}" aria-label="${esc(c.label)}" aria-pressed="${c.enabled}" title="${esc(c.label)}: ${c.enabled?'ON · Turn off':'OFF · Turn on'}">${extensionIcon(c.icon)}</button></div>${activeCount===0?'<p class="agent-muted">Empty</p>':''}${entries.length?`<details class="agent-auto-history" data-agent-detail="${esc(c.id)}-activity"><summary>History${a.total>entries.length?` <span class="agent-muted">Latest ${entries.length}</span>`:''}</summary>${entries.map(e=>entryMarkup(e,`${c.id}-${e.id}`)).join('')}</details>`:''}<p class="agent-muted" data-extension-message role="status"></p></section>`;
 }).join('');
}
export function agentMarkup(data) {
 if(!data.connected)return '<p class="agent-empty">No agent connected.</p>';
 const work=data.work,queue=data.queue;
 return `<section class="agent-section agent-settings-section" aria-label="Settings">${settingsMarkup(data)}</section>
 <section class="agent-section"><h3 title="Shared across your Codex account">Usage</h3>${data.usage===null?'<p>Usage unavailable.</p>':(data.usage||[]).flatMap(bucket=>bucket.windows.map(w=>`<div class="agent-window"><div class="agent-usage-label"><span>${esc(bucket.name)} · ${period(w.minutes)}</span><strong>${w.remaining===null?'Unavailable':`${Math.round(w.remaining)}% left`}</strong></div>${w.remaining===null?'':`<progress max="100" value="${w.remaining}" aria-label="${esc(bucket.name)} ${Math.round(w.remaining)}% left"></progress>`}<p class="agent-muted">${w.resetAt===null?'Reset time unavailable':`Resets ${date(w.resetAt)}`}</p></div>`)).join('')||'<p>No usage data.</p>'}</section>
 <section class="agent-section"><h3>Activity</h3><div class="agent-current">${workMarkup(work)}</div></section>
 <section class="agent-section"><h3>Queue${queue?` <span class="agent-count">${queue.items.length}${queue.truncated?'+':''}</span>`:''}</h3>${queue?queue.items.length?`<ol class="agent-queue">${queue.items.map(q=>`<li>${q.goalId?`<a href="#/goal/${esc(q.goalId)}">#${esc(q.goalId)} ${esc(q.title)}</a>`:esc(q.title)}</li>`).join('')}</ol>`:'<p class="agent-muted">Empty</p>':'<p class="agent-muted">Queue unavailable.</p>'}</section>
 ${data.extensions===null?'<section class="agent-section"><p class="agent-muted">Extensions unavailable.</p></section>':activityMarkup(data.extensions)}`;
}
export function createAgentMenu({button,panel,content,getGoalId}) {
 let opened=false,request=0,controller=null,timer=null,focusBefore=null,current=null,saving=false;
 const refreshButton=panel.querySelector('[data-agent-refresh]');
 function render(data){
  const expanded=new Set([...content.querySelectorAll('details[open][data-agent-detail]')].map(d=>d.dataset.agentDetail)),scroll=panel.scrollTop;
  current=data;content.innerHTML=agentMarkup(data)+extensionMarkup(data.extensions?.filter(c=>c.placement!=='header'&&!c.activity));
  for(const d of content.querySelectorAll('details[data-agent-detail]'))d.open=expanded.has(d.dataset.agentDetail);
  panel.scrollTop=scroll;
  const form=content.querySelector('[data-agent-settings]');if(!form)return;
  const model=form.elements.model,effort=form.elements.effort;
  function options(){const m=data.models.find(m=>m.id===model.value);const previous=effort.value||data.settings.reasoning;effort.innerHTML=m.efforts.map(e=>`<option value="${esc(e)}">${esc(e)}</option>`).join('');effort.value=m.efforts.includes(previous)?previous:m.defaultEffort||m.efforts[0];}
  options();model.addEventListener('change',options);
 }
 content.addEventListener('submit',event=>event.preventDefault());
 async function saveExtension(controlId,enabled,selector){
  if(saving)return;
  const id=getGoalId(),data=current,control=data.extensions.find(c=>c.id===controlId);if(!control)return;
  const token=++request;controller?.abort();saving=true;
  content.querySelectorAll('input,select,button').forEach(el=>el.disabled=true);refreshButton.disabled=true;
  try{
   const response=await fetch(`/api/goals/${id}/extensions/${control.id}?activity=1`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled,rootId:control.rootId}),signal:AbortSignal.timeout(30000)});
   const result=await response.json();if(!response.ok)throw Error(result.error||'Could not save.');
   if(opened&&token===request&&id===getGoalId()){render({...data,extensions:result});content.querySelector(selector)?.focus({preventScroll:true});}
   window.dispatchEvent(new CustomEvent('chill-extensions-changed'));
  }catch(error){if(opened&&token===request&&id===getGoalId()){render(data);const target=content.querySelector(selector);target?.focus({preventScroll:true});target?.closest('.agent-section').querySelector('[data-extension-message]')?.append(error.name==='TimeoutError'?'Save unconfirmed. Refresh to check.':error.message);}}
  finally{saving=false;refreshButton.disabled=false;if(opened&&token!==request)void refresh();}
 }
 content.addEventListener('click',event=>{
  const button=event.target.closest('[data-agent-extension]');if(!button)return;
  void saveExtension(button.dataset.agentExtension,button.getAttribute('aria-pressed')!=='true',`[data-agent-extension="${button.dataset.agentExtension}"]`);
 });
 content.addEventListener('change',async event=>{
  if(event.target.matches('[data-extension]')){
   void saveExtension(event.target.dataset.extension,event.target.checked,`[data-extension="${event.target.dataset.extension}"]`);return;
  }
  const form=event.target.closest('[data-agent-settings]');if(!form||saving)return;
  const focusName=event.target.name;
  const id=getGoalId(),data=current;
  const input={threadId:data.threadId,model:form.elements.model.value,effort:form.elements.effort.value,expected:{model:data.settings.model,effort:data.settings.reasoning}};
  if(input.model===data.settings.model&&input.effort===data.settings.reasoning)return;
  const token=++request;controller?.abort();saving=true;
  content.querySelectorAll('input,select,button').forEach(el=>el.disabled=true);
  refreshButton.disabled=true;form.querySelector('[data-settings-message]').textContent='Saving…';
  try{const response=await fetch(`/api/goals/${id}/agent`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(30000)});const result=await response.json();if(!response.ok)throw Error(result.error||'Could not save.');if(opened&&token===request&&id===getGoalId()){render({...result,extensions:data.extensions});const message=content.querySelector('[data-settings-message]');if(message)message.textContent='Saved';if(document.activeElement===document.body||form.contains(document.activeElement))content.querySelector(`[name="${focusName}"]`)?.focus({preventScroll:true});}}
  catch(error){if(opened&&token===request&&id===getGoalId()){render(data);content.querySelector('[data-settings-message]').textContent=error.name==='TimeoutError'?'Save unconfirmed. Refresh to check.':error.message;}}
  finally{saving=false;for(const el of form.elements)el.disabled=false;refreshButton.disabled=false;content.removeAttribute('aria-busy');if(opened&&token!==request)void refresh();}
 });
 async function refresh(){
  const id=getGoalId();if(!opened||!id||saving)return;
  const token=++request;controller?.abort();controller=new AbortController();
  refreshButton.disabled=true;content.setAttribute('aria-busy','true');
  try{const options={signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]),cache:'no-store'};const [response,extensionResponse]=await Promise.all([fetch(`/api/goals/${id}/agent`,options),fetch(`/api/goals/${id}/extensions?activity=1`,options).catch(()=>null)]);if(!response.ok)throw new Error();const data=await response.json();data.extensions=extensionResponse?.ok?await extensionResponse.json():null;
   if(!opened||token!==request||id!==getGoalId())return;
   // Do not replace a focused link during an automatic refresh.
   if(!content.contains(document.activeElement)&&!window.getSelection()?.toString())render(data);
  }catch(error){if(error.name!=='AbortError'&&opened&&token===request)content.innerHTML='<p class="agent-empty">Agent unavailable. Refresh to retry.</p>';}
  finally{if(token===request){refreshButton.disabled=false;content.removeAttribute('aria-busy');}}
 }
 function close({restore=false}={}){if(!opened)return;opened=false;request++;controller?.abort();clearInterval(timer);panel.hidden=true;button.setAttribute('aria-expanded','false');if(restore)(focusBefore?.isConnected?focusBefore:button).focus({preventScroll:true});}
 function open(){if(!getGoalId())return;opened=true;focusBefore=document.activeElement;panel.hidden=false;button.setAttribute('aria-expanded','true');content.innerHTML='<p class="agent-empty">Loading…</p>';panel.querySelector('[data-agent-close]').focus({preventScroll:true});void refresh();timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh();},15000);}
 button.addEventListener('click',()=>opened?close({restore:true}):open());
 panel.querySelector('[data-agent-close]').addEventListener('click',()=>close({restore:true}));refreshButton.addEventListener('click',refresh);
 document.addEventListener('pointerdown',e=>{if(opened&&!panel.contains(e.target)&&!button.contains(e.target))close();});
 document.addEventListener('focusin',e=>{if(opened&&!panel.contains(e.target)&&!button.contains(e.target))close();});
 document.addEventListener('keydown',e=>{if(opened&&e.key==='Escape'){e.preventDefault();close({restore:true});}});
 panel.addEventListener('click',e=>{if(e.target.closest('a'))close({restore:true});});
 window.addEventListener('blur',()=>setTimeout(()=>{if(opened&&document.activeElement?.tagName==='IFRAME')close();},0));
 document.addEventListener('visibilitychange',()=>{if(opened&&document.visibilityState==='visible')void refresh();});
 window.addEventListener('chill-extensions-changed',()=>{if(opened)void refresh();});
 window.addEventListener('chill-agent-presence',event=>{
  if(!opened||event.detail.routeGoalId!==getGoalId()||!current?.connected)return;
  current.work=event.detail;const target=content.querySelector('.agent-current');
  if(target&&!target.contains(document.activeElement))target.innerHTML=workMarkup(event.detail);
 });
 return {routeChanged(){close();current=null;button.hidden=!getGoalId();},close};
}
