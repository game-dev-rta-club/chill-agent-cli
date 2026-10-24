import {themes,defaultTheme,defaultTabIcon,browserThemeColor,tabIcons,resolveAppearance} from './theme-catalog.js';
// Inside a Root the panel edits that Root's look; on the Goal list it edits the
// project default that Roots without their own choice follow.
export function createThemeMenu({button,closeMore,restoreMore}) {
 const panel=document.createElement('section');panel.className='theme-panel extension-panel';panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-label','Color theme');document.body.append(panel);
 panel.innerHTML='<div class="extension-panel-heading"><h2>Color theme</h2><button type="button" aria-label="Close color theme">×</button></div><p class="agent-muted theme-scope"><span></span> <button type="button" class="theme-reset" hidden>Use project default</button></p>'
  +`<section class="theme-section"><h3>Tab icon</h3><div class="tab-icon-grid"><span></span><span>Idle</span><span>Waiting</span><span>Running</span>${tabIcons.map(i=>`<button type="button" data-icon-choice="${i.id}" aria-label="Tab icon ${i.name}" aria-pressed="false"><span class="tab-icon-name"><span class="tab-icon-radio" aria-hidden="true"></span>${i.name}</span><img src="${i.idle}" alt=""><img src="${i.waiting}" alt=""><img src="${i.working}" alt=""></button>`).join('')}</div></section>`
  +'<section class="theme-section"><h3>Page</h3>'+['gradient','light','dark'].map(kind=>`<fieldset><legend>${{gradient:'Gradient',light:'Light',dark:'Dark'}[kind]}</legend><div class="theme-grid">${themes.filter(t=>t.kind===kind).map(t=>`<button type="button" data-theme-choice="${t.id}" aria-label="${kind} ${t.name}" aria-pressed="false"><span class="theme-swatch swatch-${t.id}" aria-hidden="true"></span><span>${t.name}</span></button>`).join('')}</div></fieldset>`).join('')+'</section><p class="theme-message" role="status"></p>';
 // Start from what the page was served with, including the Root the boot script chose.
 const boot=(()=>{try{return JSON.parse(document.querySelector('meta[name="workspace-appearance"]')?.content);}catch{return null;}})();
 let stored=boot?.stored||{theme:document.documentElement.dataset.theme||defaultTheme,tabIcon:defaultTabIcon,roots:{}},busy=false,revision=0;
 let rootId=boot?.goals?.[/^#\/goal\/([1-9][0-9]*)/.exec(location.hash)?.[1]]||null;
 const status=panel.querySelector('[role=status]'),scope=panel.querySelector('.theme-scope span'),reset=panel.querySelector('.theme-reset');
 const choices=()=>panel.querySelectorAll('[data-theme-choice],[data-icon-choice],.theme-reset');
 function apply(value){
  if(value)stored=value;const look=resolveAppearance(stored,rootId);
  document.documentElement.dataset.theme=look.theme;document.documentElement.dataset.tabIcon=look.tabIcon;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content',browserThemeColor(look.theme));
  window.dispatchEvent(new CustomEvent('chill-agent-appearance',{detail:look}));
  for(const b of panel.querySelectorAll('[data-theme-choice]'))b.setAttribute('aria-pressed',String(b.dataset.themeChoice===look.theme));
  for(const b of panel.querySelectorAll('[data-icon-choice]'))b.setAttribute('aria-pressed',String(b.dataset.iconChoice===look.tabIcon));
  scope.textContent=rootId?`Saved for Root #${rootId}, on all your devices.`:'Project default for Roots without their own choice, on all your devices.';
  reset.hidden=!look.custom;
 }
 function close(restore=false){panel.hidden=true;button.setAttribute('aria-expanded','false');if(restore){restoreMore();button.focus();}}
 async function refresh(){const version=revision;try{const r=await fetch('/api/workspace/theme',{cache:'no-store'});if(!r.ok)throw Error();const value=await r.json();if(!busy&&version===revision)apply(value);}catch{if(!panel.hidden&&!busy)status.textContent='Could not load the saved theme. Try again.';}}
 async function save(change){
  busy=true;revision++;status.textContent='Saving…';for(const b of choices())b.disabled=true;
  const target=rootId;
  try{const r=await fetch('/api/workspace/theme',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...change,...(target?{rootId:target}:{})})});if(!r.ok)throw Error();apply(await r.json());status.textContent=change.reset?'This Root follows the project default.':target?`Saved for Root #${target}.`:'Saved as the project default.';}
  catch{status.textContent='Could not save. Your previous theme is unchanged.';}
  finally{busy=false;for(const b of choices())b.disabled=false;}
 }
 button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-expanded','false');
 button.onclick=()=>{const open=panel.hidden;closeMore();close();if(open){status.textContent='';panel.hidden=false;button.setAttribute('aria-expanded','true');apply();panel.querySelector('[aria-label="Close color theme"]').focus();void refresh();}};
 panel.querySelector('[aria-label="Close color theme"]').onclick=()=>close(true);
 panel.addEventListener('click',event=>{
  if(busy)return;
  const theme=event.target.closest('[data-theme-choice]'),icon=event.target.closest('[data-icon-choice]');
  if(theme)void save({theme:theme.dataset.themeChoice});else if(icon)void save({tabIcon:icon.dataset.iconChoice});else if(event.target.closest('.theme-reset'))void save({reset:true});
 });
 document.addEventListener('pointerdown',e=>{if(!panel.hidden&&!panel.contains(e.target)&&!button.contains(e.target))close();});
 document.addEventListener('keydown',e=>{if(!panel.hidden&&e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();close(true);}else if(!panel.hidden&&e.key==='Tab'){const items=[...panel.querySelectorAll('button:not(:disabled):not([hidden])')],first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
 window.addEventListener('hashchange',()=>close());window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void refresh();});
 apply();
 // The page calls this whenever the open Goal's Root may have changed.
 return {close,rootChanged(id){if((id||null)===rootId)return;rootId=id||null;apply();}};
}
