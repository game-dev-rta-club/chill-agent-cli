import {letterState,rootLetterSummary,unreadReply,counted,rootOf} from './letter-state.js';
import {browserClientId} from './browser-context.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// The menu's mark: a bell, struck through while what it stands for is off.
const bell=off=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>${off?'<path d="M4 3 20 21"/>':''}</svg>`;
const check='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
// Unanswered Letters and unread replies under the current Root (all Roots on the
// index). Letters always list, as they wait for an answer; count is what this
// browser chose to count, per Root.
export function waitingMessages(goals,events,currentId){
 const root=rootLetterSummary(goals,events,currentId)?.rootId,byId=new Map(goals.map(g=>[g.id,g]));
 const belongs=id=>{const seen=new Set();while(id&&!seen.has(id)){if(id===root)return true;seen.add(id);id=byId.get(id)?.parentId;}return !root;};
 const mine=events.filter(e=>byId.has(e.goalId)&&belongs(e.goalId));
 const letters=mine.filter(e=>letterState(e,events)?.status==='open');
 const replies=mine.filter(e=>unreadReply(e,byId.get(e.goalId))&&counted(rootOf(byId,e.goalId),'replies'));
 return {letters,replies,count:replies.length+letters.filter(e=>counted(rootOf(byId,e.goalId),'letters')).length};
}
export function createLettersMenu({button,panel,readReplies,countsChanged}){
 const head=document.createElement('div'),body=document.createElement('div'),status=document.createElement('p');
 head.className='agent-panel-heading letters-head';head.innerHTML=`<h2>Notification</h2><div class="letters-control"></div><button type="button" class="letters-read" data-replies-read title="Mark all read" aria-label="Mark all read" hidden>${check}All read</button>`;
 const slot=head.querySelector('.letters-control'),read=head.querySelector('[data-replies-read]');
 status.className='extension-message';status.setAttribute('role','status');panel.append(head,status,body);
 let signature='',shownReplies=[],latest=null,control=null,rootId=null,counts=null,notify=null;
 const close=(restore=false)=>{panel.hidden=true;button.setAttribute('aria-expanded','false');if(restore)button.focus({preventScroll:true});};
 button.onclick=()=>{const opening=panel.hidden;panel.hidden=!opening;button.setAttribute('aria-expanded',String(opening));if(opening)panel.querySelector('a,button')?.focus();};
 panel.addEventListener('click',e=>{if(e.target.closest('[data-replies-read]'))readReplies(shownReplies);else if(e.target.closest('a'))close();});
 document.addEventListener('pointerdown',e=>{if(!panel.contains(e.target)&&!button.contains(e.target))close();});
 document.addEventListener('focusin',e=>{if(!panel.contains(e.target)&&!button.contains(e.target))close();});
 document.addEventListener('keydown',e=>{if(!panel.hidden&&e.key==='Escape'){e.preventDefault();close(true);}});
 const api=signal=>async(path,payload)=>{
  const response=await fetch(`/api/extensions/${control.id}/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(60000)])});
  const result=await response.json();if(!response.ok)throw Error(result.error||'Could not save.');return result;
 };
 const changed=()=>window.dispatchEvent(new CustomEvent('chill-extensions-changed'));
 body.addEventListener('click',async e=>{
  const kind=e.target.closest('[data-count]')?.dataset.count;if(!kind)return;
  const before=counts,root=rootId,next={...counts,[kind]:!counts[kind]};
  status.textContent='';countsChanged(root,next);
  try{await api(AbortSignal.timeout(60000))('kinds',{goalId:latest.currentId,rootId:root,deviceId:browserClientId(),...next});countsChanged(root,next);changed();}
  catch(error){countsChanged(root,before);status.textContent=error.message;}
 });
 // The switch in the top row belongs to the extension, and lasts while the Goal stays open.
 async function showNotify(goalId){
  const key=control&&goalId;
  if(notify?.key===key){notify?.view?.update(control);return;}
  notify?.abort.abort();notify=null;slot.replaceChildren();
  if(!key)return;
  const mine=notify={key,abort:new AbortController()},{signal}=mine.abort;
  try{
   const module=await import(control.panelModule);if(signal.aborted)return;
   mine.view=await module.mount({element:slot,control,goalId,clientId:browserClientId(),api:api(signal),changed,signal});
  }catch(error){if(!signal.aborted)slot.textContent=error.message;}
 }
 function update(goals,events,currentId){
  latest={goals,events,currentId};
  const {letters,replies,count}=waitingMessages(goals,events,currentId),root=rootOf(new Map(goals.map(g=>[g.id,g])),currentId),notifying=Boolean(control?.enabled);
  shownReplies=replies;rootId=root?.id??null;counts={letters:counted(root,'letters'),replies:counted(root,'replies')};
  button.classList.toggle('is-on',count>0);button.setAttribute('aria-label',`Notification · ${letters.length} unanswered Letters, ${replies.length} unread replies${control?` · ${notifying?'on':'off'}`:''}`);
  const markup=bell(control&&!notifying)+`<span class="header-letter-count">${count}</span>`;
  if(button.innerHTML!==markup)button.innerHTML=markup;
  read.hidden=!replies.length;
  const switches=Boolean(control&&rootId&&browserClientId());
  const item=e=>[e.id,e.title,e.goalId,goals.find(g=>g.id===e.goalId)?.title];
  const next=JSON.stringify([currentId,letters.map(item),replies.map(item),switches,counts]);
  if(next!==signature){
   signature=next;
   const list=items=>`<ul class="header-letter-list">${items.map(e=>`<li><a href="#/goal/${e.goalId}/letter/${e.id}"><strong>${esc(e.title||goals.find(g=>g.id===e.goalId)?.title)}</strong><small>${esc(e.title?goals.find(g=>g.id===e.goalId)?.title:Array.from(e.text||'').slice(0,80).join(''))}</small></a></li>`).join('')}</ul>`;
   const toggle=(kind,label)=>switches?`<button type="button" class="letters-count-toggle" role="switch" data-count="${kind}" aria-checked="${counts[kind]}" aria-label="Count ${label} and notify them" title="${label}: ${counts[kind]?'on':'off'}">${bell(!counts[kind])}</button>`:'';
   const heading=(label,number,kind)=>`<div class="letters-section"><h3>${label}${number===null?'':` <small>${number}</small>`}</h3>${toggle(kind,label)}</div>`;
   const showReplies=counts.replies||!rootId,focused=document.activeElement?.dataset?.count;
   body.innerHTML=heading('Letters',letters.length,'letters')+(letters.length?list(letters):'<p class="agent-muted">No unanswered Letters.</p>')
    +heading('Replies',showReplies?replies.length:null,'replies')+(showReplies?replies.length?list(replies):'<p class="agent-muted">No unread replies.</p>':'');
   if(focused)body.querySelector(`[data-count="${focused}"]`)?.focus();
  }
  void showNotify(rootId&&currentId);
 }
 return {close,update,controlsChanged(controls){
  control=controls.find(c=>c.placement==='letters')||null;
  if(latest)update(latest.goals,latest.events,latest.currentId);
 }};
}
