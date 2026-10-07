import {themes,defaultTheme,validTheme} from './theme-catalog.js';
export function createThemeMenu({button,closeMore,restoreMore}) {
 const panel=document.createElement('section');panel.className='theme-panel extension-panel';panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-label','Color theme');document.body.append(panel);
 panel.innerHTML='<div class="extension-panel-heading"><h2>Color theme</h2><button type="button" aria-label="Close color theme">×</button></div><p class="agent-muted">Saved for this project, on all your devices.</p>'+['gradient','light','dark'].map(kind=>`<fieldset><legend>${{gradient:'Gradient',light:'Light',dark:'Dark'}[kind]}</legend><div class="theme-grid">${themes.filter(t=>t.kind===kind).map(t=>`<button type="button" data-theme-choice="${t.id}" aria-label="${kind} ${t.name}" aria-pressed="false"><span class="theme-swatch swatch-${t.id}" aria-hidden="true"></span><span>${t.name}</span></button>`).join('')}</div></fieldset>`).join('')+'<p class="theme-message" role="status"></p>';
 let saved=document.documentElement.dataset.theme||defaultTheme,busy=false,revision=0;
 const status=panel.querySelector('[role=status]');
 function apply(id){if(!validTheme(id))return;saved=id;document.documentElement.dataset.theme=id;for(const b of panel.querySelectorAll('[data-theme-choice]'))b.setAttribute('aria-pressed',String(b.dataset.themeChoice===id));}
 function close(restore=false){panel.hidden=true;button.setAttribute('aria-expanded','false');if(restore){restoreMore();button.focus();}}
 async function refresh(){const version=revision;try{const r=await fetch('/api/workspace/theme',{cache:'no-store'});if(!r.ok)throw Error();const value=await r.json();if(!busy&&version===revision)apply(value.theme);}catch{if(!panel.hidden&&!busy)status.textContent='Could not load the saved theme. Try again.';}}
 button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-expanded','false');
 button.onclick=()=>{const open=panel.hidden;closeMore();close();if(open){panel.hidden=false;button.setAttribute('aria-expanded','true');apply(saved);panel.querySelector('[aria-label="Close color theme"]').focus();void refresh();}};
 panel.querySelector('[aria-label="Close color theme"]').onclick=()=>close(true);
 panel.addEventListener('click',async event=>{
  const choice=event.target.closest('[data-theme-choice]');if(!choice||busy)return;
  busy=true;revision++;status.textContent='Saving…';for(const b of panel.querySelectorAll('[data-theme-choice]'))b.disabled=true;
  try{const r=await fetch('/api/workspace/theme',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({theme:choice.dataset.themeChoice})});if(!r.ok)throw Error();apply((await r.json()).theme);status.textContent='Saved for this project.';}
  catch{status.textContent='Could not save. Your previous theme is unchanged.';}
  finally{busy=false;for(const b of panel.querySelectorAll('[data-theme-choice]'))b.disabled=false;}
 });
 document.addEventListener('pointerdown',e=>{if(!panel.hidden&&!panel.contains(e.target)&&!button.contains(e.target))close();});
 document.addEventListener('keydown',e=>{if(!panel.hidden&&e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();close(true);}else if(!panel.hidden&&e.key==='Tab'){const items=[...panel.querySelectorAll('button:not(:disabled)')],first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
 window.addEventListener('hashchange',()=>close());window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void refresh();});
 apply(saved);return {close};
}
