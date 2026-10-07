import {createThemeMenu} from './theme-menu.js';
import {browserClientId} from './browser-context.js';
import {confirmAction} from './confirmation-dialog.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const repeatIcon=`<svg class="monitor-logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="coffee-fill" d="M3 6h14v6a6 6 0 0 1-6 6H9a6 6 0 0 1-6-6z"/><path d="M17 8h2a3 3 0 0 1 0 6h-2"/><path class="coffee-steam" d="M7 4c-2-1 2-2 0-3m6 3c-2-1 2-2 0-3"/></svg>`;
const bellIcon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>';
export const extensionIcon=icon=>icon==='bell'?bellIcon:icon==='repeat'?repeatIcon:icon==='globe'?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></svg>':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M8 12h8"/></svg>';
export function createExtensionButtons({container,getGoalId,announce=()=>{}}){
 let controls=[],generation=0,controller=null,opened=null,panelController=null,cleanup=null;
 const more=document.createElement('button');more.type='button';more.className='extension-more';more.setAttribute('aria-label','More');more.setAttribute('aria-expanded','false');more.setAttribute('aria-controls','extension-list');
 more.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg><span>More</span>';
 const list=document.createElement('div');list.id='extension-list';list.className='extension-list';list.setAttribute('aria-label','Settings');
 const goals=document.createElement('a');goals.href='#/goals';goals.className='extension-trigger';goals.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg><span class="extension-name">Goals</span>';goals.onclick=()=>showMore(false);list.append(goals);
 const theme=document.createElement('button');theme.type='button';theme.className='extension-trigger';theme.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16Z"/></svg><span class="extension-name">Color theme</span>';list.append(theme);
 const themeMenu=createThemeMenu({button:theme,closeMore:()=>showMore(false),restoreMore:()=>showMore(true)});
 container.hidden=false;container.append(more,list);
 function showMore(value,restore=false){container.classList.toggle('is-open',value);more.setAttribute('aria-expanded',String(value));if(restore)more.focus({preventScroll:true});}
 more.onclick=()=>{themeMenu.close();const next=more.getAttribute('aria-expanded')!=='true';close();showMore(next);};
 const panel=document.createElement('section');panel.className='extension-panel';panel.hidden=true;panel.setAttribute('role','dialog');document.body.append(panel);
 function close(restore=false){const id=opened;opened=null;panelController?.abort();cleanup?.();cleanup=null;panel.hidden=true;render();if(restore)more.focus({preventScroll:true});}
 function render(unknown=false){
  const retained=new Set();container.hidden=false;
  for(const c of controls.filter(c=>c.placement==='header')){
   if(c.manifest?.startsWith(`/extensions/${c.id}/`)&&!document.querySelector('link[rel="manifest"]')){const link=document.createElement('link');link.rel='manifest';link.href=c.manifest;document.head.append(link);}
   retained.add(c.id);let wrapper=container.querySelector(`[data-header-extension="${c.id}"]`)?.parentElement;
   if(!wrapper){wrapper=document.createElement('span');wrapper.className='extension-control';wrapper.innerHTML=`<button type="button" class="extension-trigger" data-header-extension="${esc(c.id)}"></button><span class="extension-tooltip" role="tooltip" id="extension-tip-${esc(c.id)}"></span>`;list.append(wrapper);}
   const button=wrapper.querySelector('button');button.setAttribute('aria-label',c.label);button.setAttribute('aria-describedby',`extension-tip-${c.id}`);button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-expanded',String(opened===c.id));
   button.setAttribute('aria-pressed',String(c.enabled));button.disabled=unknown;button.removeAttribute('title');
   const icon=extensionIcon(c.icon)+`<span class="extension-name">${esc(c.label)}</span><span class="extension-value">${unknown?'Unavailable':c.enabled?'On':'Off'}</span>`;if(button.innerHTML!==icon)button.innerHTML=icon;
   wrapper.querySelector('[role="tooltip"]').innerHTML=`${esc(c.label)} · ${unknown?'Unavailable':c.enabled?'On':'Off'}<small>${esc(c.description||'Prompts the agent to keep going.')}</small>`;
  }
  for(const button of container.querySelectorAll('[data-header-extension]'))if(!retained.has(button.dataset.headerExtension))button.parentElement.remove();
 }
 async function refresh(){
  const id=getGoalId();if(!id)return;
  const token=++generation;controller?.abort();controller=new AbortController();
  const clientId=browserClientId();
  try{const response=await fetch(`/api/goals/${id}/extensions${clientId?`?clientId=${clientId}`:''}`,{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])});if(!response.ok)throw Error();const data=await response.json();if(token!==generation||id!==getGoalId())return;controls=data;render();}
  catch(error){if(error.name!=='AbortError'&&token===generation&&id===getGoalId())render(true);}
 }
 async function open(id){
  if(opened===id){close(true);return;}
  showMore(false);close();const control=controls.find(c=>c.id===id),goalId=getGoalId();if(!control)return;
  opened=id;panelController=new AbortController();const signal=panelController.signal;
  panel.setAttribute('aria-label',control.label);panel.innerHTML=`<div class="extension-panel-heading"><h2>${esc(control.label)}</h2><button type="button" data-panel-close aria-label="Close">×</button></div><div data-panel-content><p class="agent-muted">Loading…</p></div>`;
  panel.hidden=false;render();panel.querySelector('[data-panel-close]').onclick=()=>close(true);panel.querySelector('[data-panel-close]').focus();
  const element=panel.querySelector('[data-panel-content]');
  const changed=()=>{void refresh();window.dispatchEvent(new CustomEvent('chill-extensions-changed'));};
  async function api(path,body){
   const response=await fetch(`/api/extensions/${id}/${path}`,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(60000)])});
   const result=await response.json();if(!response.ok)throw Error(result.error||'Could not save.');return result;
  }
  try{
   if(control.panelModule){
    if(!control.panelModule.startsWith(`/extensions/${id}/`)||control.panelModule.includes('..'))throw Error('Invalid extension panel.');
    const module=await import(control.panelModule);if(signal.aborted)return;
    cleanup=await module.mount({element,control,goalId,clientId:browserClientId(),api,changed,signal,confirm:options=>confirmAction({...options,signal})});
   }else{
    element.innerHTML=`<label class="agent-extension"><span>On / Off</span><input type="checkbox" role="switch" aria-label="${esc(control.label)}" ${control.enabled?'checked':''}></label><p class="agent-muted">${esc(control.description||'Prompts the agent to keep going.')}</p><p class="extension-message" role="status"></p>`;
    const toggle=element.querySelector('input');toggle.onchange=async()=>{
     toggle.disabled=true;
     try{const response=await fetch(`/api/goals/${goalId}/extensions/${id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rootId:control.rootId,enabled:toggle.checked}),signal});const result=await response.json();if(!response.ok)throw Error(result.error||'Could not save.');changed();}
     catch(error){if(!signal.aborted){toggle.checked=!toggle.checked;element.querySelector('[role="status"]').textContent=error.message;}}
     finally{toggle.disabled=false;}
    };
   }
  }catch(error){if(!signal.aborted)element.textContent=error.message;}
 }
 container.addEventListener('click',event=>{const b=event.target.closest('[data-header-extension]');if(b)void open(b.dataset.headerExtension);});
 const outside=e=>opened&&!panel.contains(e.target)&&!container.contains(e.target)&&!e.target.closest('.extension-confirm');
 document.addEventListener('pointerdown',e=>{if(!container.contains(e.target))showMore(false);if(outside(e))close();});
 document.addEventListener('focusin',e=>{if(!container.contains(e.target))showMore(false);if(outside(e))close();});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&more.getAttribute('aria-expanded')==='true'){e.preventDefault();showMore(false,true);return;}if(opened&&e.key==='Escape'&&!e.target.closest('.extension-confirm')){e.preventDefault();close(true);}});
 const timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh();},15000);
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void refresh();});
 window.addEventListener('focus',refresh);window.addEventListener('chill-extensions-changed',refresh);
 return {routeChanged(){showMore(false);close();generation++;controller?.abort();if(!getGoalId())controls=[];render(true);void refresh();},refresh,destroy(){close();panel.remove();clearInterval(timer);controller?.abort();window.removeEventListener('focus',refresh);window.removeEventListener('chill-extensions-changed',refresh);}};
}
