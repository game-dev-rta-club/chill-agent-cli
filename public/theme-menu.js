import {themes,defaultTheme,defaultTabIcon,browserThemeColor,tabIcons,resolveAppearance} from './theme-catalog.js';
// Two panels share one saved appearance. More → Color theme picks the page
// theme; the header icon picks the tab icon set. Inside a Root each edits that
// Root's look; on the Goal list each edits the project default that Roots
// without their own choice follow.
export function createThemeMenu({button,iconButton,closeMore,restoreMore}) {
 const dialog=(label,className,body)=>{const panel=document.createElement('section');panel.className=`${className} extension-panel`;panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-label',label);panel.innerHTML=`<div class="extension-panel-heading"><h2>${label}</h2><button type="button" aria-label="Close ${label.toLowerCase()}">×</button></div><p class="agent-muted theme-scope"></p>${body}<p class="theme-message" role="status"></p>`;document.body.append(panel);return panel;};
 const themePanel=dialog('Color theme','theme-panel','<p class="theme-reset-line" hidden><button type="button" class="theme-reset">Use project default</button></p>'+['gradient','light','dark'].map(kind=>`<fieldset><legend>${{gradient:'Gradient',light:'Light',dark:'Dark'}[kind]}</legend><div class="theme-grid">${themes.filter(t=>t.kind===kind).map(t=>`<button type="button" data-theme-choice="${t.id}" aria-label="${kind} ${t.name}" aria-pressed="false"><span class="theme-swatch swatch-${t.id}" aria-hidden="true"></span><span>${t.name}</span></button>`).join('')}</div></fieldset>`).join(''));
 const iconPanel=dialog('Tab icon','tab-icon-panel',`<div class="tab-icon-grid"><span></span><span>Idle</span><span>Waiting</span><span>Running</span>${tabIcons.map(i=>`<button type="button" data-icon-choice="${i.id}" aria-label="Tab icon ${i.name}" aria-pressed="false"><span class="tab-icon-name"><span class="tab-icon-radio" aria-hidden="true"></span>${i.name}</span><img src="${i.idle}" alt=""><img src="${i.waiting}" alt=""><img src="${i.working}" alt=""></button>`).join('')}</div>`);
 const panels=[themePanel,iconPanel],owner=panel=>panel===themePanel?button:iconButton;
 // Start from what the page was served with, including the Root the boot script chose.
 const boot=(()=>{try{return JSON.parse(document.querySelector('meta[name="workspace-appearance"]')?.content);}catch{return null;}})();
 let stored=boot?.stored||{theme:document.documentElement.dataset.theme||defaultTheme,tabIcon:defaultTabIcon,roots:{}},busy=false,revision=0,statusPanel=themePanel;
 let rootId=boot?.goals?.[/^#\/goal\/([1-9][0-9]*)/.exec(location.hash)?.[1]]||null;
 const choices=()=>document.querySelectorAll('[data-theme-choice],[data-icon-choice],.theme-reset');
 function apply(value){
  if(value)stored=value;const look=resolveAppearance(stored,rootId);
  document.documentElement.dataset.theme=look.theme;document.documentElement.dataset.tabIcon=look.tabIcon;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content',browserThemeColor(look.theme));
  window.dispatchEvent(new CustomEvent('chill-agent-appearance',{detail:look}));
  for(const b of themePanel.querySelectorAll('[data-theme-choice]'))b.setAttribute('aria-pressed',String(b.dataset.themeChoice===look.theme));
  for(const b of iconPanel.querySelectorAll('[data-icon-choice]'))b.setAttribute('aria-pressed',String(b.dataset.iconChoice===look.tabIcon));
  for(const scope of document.querySelectorAll('.theme-scope'))scope.textContent=rootId?`Saved for Root #${rootId}, on all your devices.`:'Project default for Roots without their own choice, on all your devices.';
  themePanel.querySelector('.theme-reset-line').hidden=!look.custom;
 }
 const status=text=>{statusPanel.querySelector('[role=status]').textContent=text;};
 function close(panel,restore=false){if(!panel||panel.hidden)return;panel.hidden=true;owner(panel)?.setAttribute('aria-expanded','false');if(restore){if(panel===themePanel)restoreMore();owner(panel)?.focus();}}
 function open(panel){for(const p of panels)close(p);panel.querySelector('[role=status]').textContent='';panel.hidden=false;owner(panel).setAttribute('aria-expanded','true');apply();panel.querySelector('.extension-panel-heading button').focus();void refresh();}
 async function refresh(){const version=revision;try{const r=await fetch('/api/workspace/theme',{cache:'no-store'});if(!r.ok)throw Error();const value=await r.json();if(!busy&&version===revision)apply(value);}catch{const panel=panels.find(p=>!p.hidden);if(panel&&!busy)panel.querySelector('[role=status]').textContent='Could not load the saved theme. Try again.';}}
 async function save(change,panel){
  busy=true;revision++;statusPanel=panel;status('Saving…');for(const b of choices())b.disabled=true;
  const target=rootId;
  try{const r=await fetch('/api/workspace/theme',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...change,...(target?{rootId:target}:{})})});if(!r.ok)throw Error();apply(await r.json());status(change.reset?'This Root follows the project default.':target?`Saved for Root #${target}.`:'Saved as the project default.');}
  catch{status(change.tabIcon?'Could not save. Your previous tab icon is unchanged.':'Could not save. Your previous theme is unchanged.');}
  finally{busy=false;for(const b of choices())b.disabled=false;}
 }
 for(const [trigger,panel] of [[button,themePanel],[iconButton,iconPanel]]){
  if(!trigger)continue;
  trigger.setAttribute('aria-haspopup','dialog');trigger.setAttribute('aria-expanded','false');
  trigger.onclick=()=>{const wasHidden=panel.hidden;if(panel===themePanel)closeMore();for(const p of panels)close(p);if(wasHidden)open(panel);};
  panel.querySelector('.extension-panel-heading button').onclick=()=>close(panel,true);
 }
 themePanel.addEventListener('click',event=>{if(busy)return;const theme=event.target.closest('[data-theme-choice]');if(theme)void save({theme:theme.dataset.themeChoice},themePanel);else if(event.target.closest('.theme-reset'))void save({reset:true},themePanel);});
 iconPanel.addEventListener('click',event=>{if(busy)return;const icon=event.target.closest('[data-icon-choice]');if(icon)void save({tabIcon:icon.dataset.iconChoice},iconPanel);});
 document.addEventListener('pointerdown',e=>{for(const p of panels)if(!p.hidden&&!p.contains(e.target)&&!owner(p)?.contains(e.target))close(p);});
 document.addEventListener('keydown',e=>{
  const panel=panels.find(p=>!p.hidden);if(!panel)return;
  if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();close(panel,true);}
  else if(e.key==='Tab'){const items=[...panel.querySelectorAll('button:not(:disabled)')].filter(b=>!b.closest('[hidden]')),first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}
 });
 window.addEventListener('hashchange',()=>{for(const p of panels)close(p);});window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void refresh();});
 apply();
 // The page calls this whenever the open Goal's Root may have changed.
 return {close:()=>close(themePanel),rootChanged(id){if((id||null)===rootId)return;rootId=id||null;apply();}};
}
