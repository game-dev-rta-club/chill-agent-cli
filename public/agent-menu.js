import {isRunning} from './goal-state.js';
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
function timeMarkup(at,seconds=false){
 const value=new Date(at);return Number.isNaN(value.getTime())?'':`<time datetime="${esc(at)}" title="${esc(value.toLocaleString())}">${esc(value.toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',...(seconds?{second:'2-digit'}:{})}))}</time>`;
}
function workMarkup(work,root={}){
 const active=isRunning(work?.status)||work?.status==='paused';
 const id=work?.goalId||root.rootId,title=work?.goalId?work.title:root.rootTitle;
 return `<span class="agent-run-state">${presenceMark(work?.status)}${presenceLabel(work?.status)}</span>${active&&id?`<a class="agent-work-link" href="#/goal/${esc(id)}">${work?.goalId?'':'Root Goal · '}#${esc(id)} ${esc(title||'Goal')} →</a>`:''}`;
}
function entryMarkup(entry,id){return `<article class="agent-auto-entry"><div class="agent-auto-meta">${timeMarkup(entry.at)}<span>${esc(entry.result?.label||entry.status)}</span></div><p>${esc(entry.summary)}</p>${entry.detail?`<p class="agent-muted">${esc(entry.detail)}</p>`:''}${entry.message?`<details data-agent-detail="${esc(id)}"><summary>View message</summary><pre class="agent-auto-message">${esc(entry.message)}</pre></details>`:'<p class="agent-muted">Message not saved.</p>'}</article>`;}
export function runActivityMarkup(controls){
 const entries=(controls||[]).flatMap(c=>(c.activity?.runs||[]).map(run=>({...run,extensionId:c.id,label:c.activity.label||c.label}))).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)).slice(0,20);
 if(!entries.length)return '';
 return `<details class="agent-runs" data-agent-detail="runs"><summary>Recent runs</summary>${entries.map(e=>`<article class="agent-run-entry"><div class="agent-auto-meta">${timeMarkup(e.at)}<span>${esc(e.result?.label||e.status)}</span></div><p>${esc(e.label)}${e.goalId?` · <a href="#/goal/${esc(e.goalId)}">#${esc(e.goalId)} ${esc(e.goalTitle||'Goal')}</a>`:''}</p><details data-agent-detail="run-${esc(e.extensionId)}-${esc(e.id)}" data-extension-run="${esc(e.extensionId)}" data-run-id="${esc(e.id)}"><summary>Run log</summary><div data-run-output><p class="agent-muted">Loading…</p></div></details></article>`).join('')}</details>`;
}
export function runOutputMarkup({work,message,error}){
 return `${error?`<p class="agent-muted">${esc(error)}</p>`:''}${work?.settings?.model?`<p class="agent-muted">${esc(work.settings.model)}${work.settings.reasoning?` · ${esc(work.settings.reasoning)}`:''}</p>`:''}${work?.messages?.length?work.messages.map(m=>`<p class="agent-run-text">${esc(m.text)}</p>`).join(''):`<p class="agent-muted">${work?'No public updates yet.':'Run output is not available yet.'}</p>`}${message?`<details><summary>Request</summary><pre class="agent-auto-message">${esc(message)}</pre></details>`:'<p class="agent-muted">Request not saved.</p>'}${!work?.endedAt||error?'<button class="text-button" type="button" data-run-refresh>Refresh log</button>':''}`;
}
export function activityMarkup(controls){
 return (controls||[]).filter(c=>c.activity&&c.menu!==false).map(c=>{
  const a=c.activity,entries=a.entries||[];
  return `<section class="agent-section agent-auto"><div class="agent-section-heading"><h3>${esc(a.label||c.label)}</h3>${c.configured===false?`<button type="button" class="agent-extension-setup" data-extension-setup="${esc(c.id)}">${esc(c.setup?.label||'Set up')}</button>`:`<button type="button" class="extension-trigger agent-auto-toggle" data-agent-extension="${esc(c.id)}" aria-label="${esc(c.label)}" aria-pressed="${c.enabled}" title="${esc(c.label)}: ${c.enabled?'ON · Turn off':'OFF · Turn on'}">${extensionIcon(c.icon)}<span>${c.enabled?'On':'Off'}</span></button>`}</div>${c.detail?`<p class="agent-muted agent-auto-empty agent-extension-detail" title="${esc(c.detail)}">${esc(c.detail)}${c.configured&&c.setup?` <button type="button" class="agent-extension-setup" data-extension-setup="${esc(c.id)}">${esc(c.setup.label)}</button>`:''}</p>`:''}${entries.length?`<details class="agent-auto-history" data-agent-detail="${esc(c.id)}-activity"><summary>History</summary>${a.total>entries.length?`<p class="agent-muted">Latest ${entries.length}</p>`:''}${entries.map(e=>entryMarkup(e,`${c.id}-${e.id}`)).join('')}</details>`:''}<p class="agent-muted" data-extension-message role="status"></p></section>`;
 }).join('');
}
export function agentMarkup(data) {
 if(data.nativeConnection){
  const s=data.nativeConnection.status;
  return `<section class="agent-section"><h3>Claude Code</h3>${s?`<p>${esc(s.label)}</p><p class="agent-muted">${esc(s.detail)}</p>${s.waiterCheckedAt?`<p class="agent-muted">Waiter checked ${timeMarkup(s.waiterCheckedAt,true)}</p>`:''}${s.observedAt?`<p class="agent-muted">Last contact ${timeMarkup(s.observedAt)}</p>`:''}`:''}<p class="agent-muted">${esc(data.nativeConnection.detail)}</p></section>`;
 }
 if(!data.connected)return '<p class="agent-empty">No agent connected.</p>';
 const work=data.work,queue=data.queue;
 return `<section class="agent-section agent-settings-section" aria-label="Settings">${settingsMarkup(data)}</section>
 <section class="agent-section"><h3 title="Shared across your Codex account">Usage</h3>${data.usage===null?'<p>Usage unavailable.</p>':(data.usage||[]).flatMap(bucket=>bucket.windows.map(w=>`<div class="agent-window"><div class="agent-usage-label"><span>${esc(bucket.name)} · ${period(w.minutes)}</span><strong>${w.remaining===null?'Unavailable':`${Math.round(w.remaining)}% left`}</strong></div>${w.remaining===null?'':`<progress max="100" value="${w.remaining}" aria-label="${esc(bucket.name)} ${Math.round(w.remaining)}% left"></progress>`}<p class="agent-muted">${w.resetAt===null?'Reset time unavailable':`Resets ${date(w.resetAt)}`}</p></div>`)).join('')||'<p>No usage data.</p>'}</section>
 <section class="agent-section"><h3>Activity</h3><div class="agent-current-row"><div class="agent-current">${workMarkup(work,data)}</div><div class="agent-current-controls">${data.capabilities?.stop?'<button type="button" class="action" data-agent-control="stop">Ⅱ Pause</button>':data.capabilities?.resume?'<button type="button" class="action" data-agent-control="resume">▶ Resume</button>':''}<span data-agent-control-message role="status"></span></div></div></section>
 <section class="agent-section"><h3>Queue${queue?` <span class="agent-count">${queue.items.length}${queue.truncated?'+':''}</span>`:''}</h3>${queue?queue.items.length?`<ol class="agent-queue">${queue.items.map(q=>`<li>${q.goalId?`<a href="#/goal/${esc(q.goalId)}">#${esc(q.goalId)} ${esc(q.title)}</a>`:esc(q.title)}</li>`).join('')}</ol>`:'<p class="agent-muted">Empty</p>':'<p class="agent-muted">Queue unavailable.</p>'}</section>
 ${data.extensions===null?'<section class="agent-section"><p class="agent-muted">Extensions unavailable.</p></section>':activityMarkup(data.extensions)}`;
}
export function createAgentMenu({button,panel,content,getGoalId}) {
 const setupRequests=new Map();
 const runLogs=new Map();
 const setupKey=(id,c)=>JSON.stringify([id,c.id,c.detail,c.setup.text]);
 let opened=false,request=0,controller=null,timer=null,focusBefore=null,current=null,saving=false;
 const refreshButton=panel.querySelector('[data-agent-refresh]');
 function render(data){
  const expanded=new Set([...content.querySelectorAll('details[open][data-agent-detail]')].map(d=>d.dataset.agentDetail)),scroll=panel.scrollTop;
  current=data;content.innerHTML=agentMarkup(data)+extensionMarkup(data.extensions?.filter(c=>c.placement!=='header'&&!c.activity));
  for(const d of content.querySelectorAll('details[data-agent-detail]'))d.open=expanded.has(d.dataset.agentDetail);
  panel.scrollTop=scroll;
  for(const c of data.extensions||[]){if(c.setup&&setupRequests.get(setupKey(getGoalId(),c))?.done){const b=content.querySelector(`[data-extension-setup="${c.id}"]`);if(b){b.textContent='Requested';b.disabled=true;}}}
  const form=content.querySelector('[data-agent-settings]');if(!form)return;
  const model=form.elements.model,effort=form.elements.effort;
  function options(){const m=data.models.find(m=>m.id===model.value);const previous=effort.value||data.settings.reasoning;effort.innerHTML=m.efforts.map(e=>`<option value="${esc(e)}">${esc(e)}</option>`).join('');effort.value=m.efforts.includes(previous)?previous:m.defaultEffort||m.efforts[0];}
  options();model.addEventListener('change',options);
 }
 content.addEventListener('submit',event=>event.preventDefault());
 async function loadRun(details,{fresh=false}={}){
  if(!details?.open||!current)return;
  const goalId=getGoalId(),threadId=current.threadId,extension=current.extensions?.find(c=>c.id===details.dataset.extensionRun);
  const entry=extension?.activity?.runs?.find(e=>e.id===details.dataset.runId);
  if(!entry?.logPath)return;
  const key=JSON.stringify([extension.rootId,threadId,extension.id,entry.id]);
  const target=details.querySelector('[data-run-output]');
  if(fresh)runLogs.delete(key);
  if(!runLogs.has(key))runLogs.set(key,(async()=>{
   const response=await fetch(`/api/extensions/${encodeURIComponent(extension.id)}/${entry.logPath.replace(/^\//,'')}?goalId=${encodeURIComponent(goalId)}`,{cache:'no-store',signal:AbortSignal.timeout(15000)});
   const data=await response.json();if(!response.ok)throw Error(data.error||'Log unavailable.');return data;
  })());
  try{
   const data=await runLogs.get(key);
   if(goalId!==getGoalId()||threadId!==current?.threadId||!target.isConnected)return;
   target.innerHTML=runOutputMarkup(data);
   if(!data.work?.endedAt||data.error)runLogs.delete(key);
  }catch(error){runLogs.delete(key);if(target.isConnected&&goalId===getGoalId())target.innerHTML='<p class="agent-muted">Log unavailable.</p><button type="button" class="text-button" data-run-refresh>Retry</button>';}
 }
 content.addEventListener('toggle',event=>{if(event.target.matches('[data-extension-run]'))void loadRun(event.target);},true);
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
 async function requestSetup(controlId){
  if(saving)return;
  const id=getGoalId(),control=current?.extensions?.find(c=>c.id===controlId);if(!control?.setup?.text)return;
  const key=setupKey(id,control);let pending=setupRequests.get(key);
  if(pending?.done)return;
  if(!pending){pending={id:crypto.randomUUID()};setupRequests.set(key,pending);}
  const token=++request;controller?.abort();saving=true;
  const button=content.querySelector(`[data-extension-setup="${controlId}"]`);button.disabled=true;
  try{
   const response=await fetch(`/api/goals/${id}/feedback`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:control.setup.text,requestId:pending.id}),signal:AbortSignal.timeout(30000)});
   const result=await response.json();if(!response.ok)throw Error(result.error||'Could not request setup.');
   pending.done=true;
   if(opened&&token===request&&id===getGoalId()){button.textContent='Requested';button.closest('.agent-section').querySelector('[data-extension-message]').textContent='Saved in Conversation.';}
  }catch(error){if(opened&&token===request&&id===getGoalId()){button.disabled=false;button.closest('.agent-section').querySelector('[data-extension-message]').textContent=error.name==='TimeoutError'?'Save unconfirmed. Retry to check.':error.message;}}
  finally{saving=false;}
 }
 content.addEventListener('click',event=>{
  const control=event.target.closest('[data-agent-control]');if(control){void controlCurrent(control.dataset.agentControl);return;}
  const refresh=event.target.closest('[data-run-refresh]');if(refresh){void loadRun(refresh.closest('[data-extension-run]'),{fresh:true});return;}
  const setup=event.target.closest('[data-extension-setup]');if(setup){void requestSetup(setup.dataset.extensionSetup);return;}
  const button=event.target.closest('[data-agent-extension]');if(!button)return;
  void saveExtension(button.dataset.agentExtension,button.getAttribute('aria-pressed')!=='true',`[data-agent-extension="${button.dataset.agentExtension}"]`);
 });
 async function controlCurrent(action){
  if(saving||!current)return;
  const id=getGoalId(),snapshot=current,token=++request;controller?.abort();saving=true;
  content.querySelectorAll('input,select,button').forEach(el=>el.disabled=true);
  const message=content.querySelector('[data-agent-control-message]');if(message)message.textContent=action==='stop'?'Pausing…':'Resuming…';
  try{
   const response=await fetch(`/api/goals/${id}/agent/control`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scope:'current',action,threadId:snapshot.threadId,turnId:snapshot.control.turnId,requestId:crypto.randomUUID()}),signal:AbortSignal.timeout(30000)});
   const result=await response.json();if(!response.ok)throw Error(result.error||'Action unconfirmed. Refresh to check.');
   if(opened&&id===getGoalId()&&token===request)render({...result,extensions:snapshot.extensions});
  }catch(error){
   if(opened&&id===getGoalId()&&token===request){
    render({...snapshot,capabilities:{...snapshot.capabilities,stop:false,resume:false}});
    const target=content.querySelector('[data-agent-control-message]');if(target)target.textContent='Action unconfirmed. Refresh to check.';
   }
  }finally{saving=false;refreshButton.disabled=false;}
 }
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
  if(target&&!target.contains(document.activeElement))target.innerHTML=workMarkup(event.detail,current);
 });
 return {routeChanged(){close();current=null;button.hidden=!getGoalId();},close};
}
