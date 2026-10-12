export async function mount({element,goalId,api,changed,signal,confirm}){
 element.innerHTML=`<label class="agent-extension"><span>On / Off</span><input type="checkbox" role="switch" aria-label="Public link"></label><p class="extension-message" data-summary>Create a link anyone can use to view and reply to all Goals.</p><p class="extension-message" data-kind></p><div data-link hidden><img class="extension-qr" alt="Scan to open this workspace"><a class="extension-url" target="_blank" rel="noopener"></a></div><div class="extension-actions"><button data-copy hidden>Copy link</button><button class="extension-help" aria-label="More about public access" aria-expanded="false">More</button></div><p class="extension-message" role="status"></p><div class="extension-info" hidden><p><strong>Who can open it?</strong><br>Temporary links let anyone with the URL view and reply to all Goals on this site. Share only with people you trust. Turn Off to close access.</p><p><strong>Keep the same URL</strong><br>Set up a named Cloudflare Tunnel and Access in your own CLI. No API token is entered here. Then save its connection with <code>chill settings remote --help</code>.</p><p><a href="/extensions/public-link/guide.html" target="_blank" rel="noopener">Custom URL guide ↗</a></p><p>A temporary URL changes after restart. Reconnect notifications on the new URL. Keep this computer awake for phone access.</p></div>`;
 const toggle=element.querySelector('input'),message=element.querySelector('[role="status"]'),kind=element.querySelector('[data-kind]'),box=element.querySelector('[data-link]'),copy=element.querySelector('[data-copy]'),info=element.querySelector('.extension-info'),help=element.querySelector('.extension-help');
 let state,saving=false;
 function render(s){state=s;element.querySelector('[data-summary]').textContent=s.custom?'Open all Goals through your Cloudflare Access link.':'Create a link anyone can use to view and reply to all Goals.';toggle.checked=s.enabled;toggle.disabled=!s.local||saving;kind.textContent=s.status==='starting'?'Creating your link and QR…':s.status==='failed'?'Could not create the link.':'';
  box.hidden=!s.url;copy.hidden=!s.url;
  if(s.url){const link=`${s.url}/#/goal/${goalId}`;box.querySelector('a').href=link;box.querySelector('a').textContent=link;box.querySelector('img').src=s.qr;}
  if(s.error)message.textContent=s.error;
  else if(s.status==='failed')message.textContent='Ask your agent to check Public link setup, including the cloudflared tool and the connection. The local page is still available.';
  else if(!s.local)message.textContent='Change public access on the computer running chill-agent.';
  else message.textContent='';
 }
 help.onclick=()=>{info.hidden=!info.hidden;help.setAttribute('aria-expanded',String(!info.hidden));};
 copy.onclick=async()=>{try{await navigator.clipboard.writeText(`${state.url}/#/goal/${goalId}`);message.textContent='Copied';}catch{message.textContent='Copy the link above.';}};
 toggle.onchange=async()=>{
  const enabled=toggle.checked;
  if(enabled&&state.confirmationRequired&&!await confirm({title:'Create public link?',message:'Anyone with the link can view and reply to all Goals on this site.',confirmLabel:'Create link'})){toggle.checked=false;return;}
  saving=true;toggle.disabled=true;message.textContent='';kind.textContent=enabled?'Creating your link and QR…':'Closing public access…';
  try{render((await api('toggle',{enabled,confirmPublic:enabled,goalId})));changed();}
  catch(error){if(!signal.aborted){message.textContent=error.message;toggle.checked=state.enabled;}}
  finally{saving=false;toggle.disabled=!state.local;}
 };
 async function refresh(){if(saving||signal.aborted)return;try{render(await api(`state?goalId=${goalId}`));}catch(error){if(!signal.aborted)message.textContent=error.message;}}
 await refresh();const timer=setInterval(refresh,2000);signal.addEventListener('abort',()=>clearInterval(timer),{once:true});return ()=>clearInterval(timer);
}
