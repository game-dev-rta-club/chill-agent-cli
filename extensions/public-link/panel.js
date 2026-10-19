export async function mount({element,goalId,api,changed,signal,confirm}){
 element.innerHTML=`<label class="agent-extension"><span>On / Off</span><input type="checkbox" role="switch" aria-label="Public link"></label><p class="extension-message" data-summary>Create a link that devices connect to with an access code, to view and reply to all Goals.</p><p class="extension-message" data-kind></p><div data-link hidden><img class="extension-qr" alt="Scan to open this workspace"><p class="extension-code" data-code hidden><span>Access code</span><strong></strong><button type="button" data-reveal aria-pressed="false">Show</button></p><a class="extension-url" target="_blank" rel="noopener"></a></div><div class="extension-devices" data-devices hidden><p>Connected devices</p><ul></ul><button data-disconnect-all hidden>Disconnect all</button></div><div class="extension-actions"><button data-copy hidden>Copy link</button><button class="extension-help" aria-label="More about public access" aria-expanded="false">More</button></div><p class="extension-message" role="status"></p><div class="extension-info" hidden><p><strong>Who can open it?</strong><br>A device connects once with the access code: scan the QR or open the link, then type the code. Connected devices can view and reply to all Goals on this site. A code works once and changes after 10 minutes. Disconnect a device in the list to remove it. Turn Off to close access.</p><p><strong>Keep the same URL</strong><br>Set up a named Cloudflare Tunnel and Access in your own CLI. No API token is entered here. Then save its connection with <code>chill settings remote --help</code>.</p><p><a href="/extensions/public-link/guide.html" target="_blank" rel="noopener">Custom URL guide ↗</a></p><p>A temporary URL changes after restart. Reconnect notifications on the new URL. Keep this computer awake for remote access.</p></div>`;
 const toggle=element.querySelector('input'),message=element.querySelector('[role="status"]'),kind=element.querySelector('[data-kind]'),box=element.querySelector('[data-link]'),copy=element.querySelector('[data-copy]'),devices=element.querySelector('[data-devices]'),code=element.querySelector('[data-code]'),info=element.querySelector('.extension-info'),help=element.querySelector('.extension-help');
 let state,saving=false,revealed=false;
 // The code stays hidden until asked for, so a glance at the screen does not give it away.
 const reveal=code.querySelector('[data-reveal]');
 function showCode(){const value=state?.code||'';code.querySelector('strong').textContent=value?(revealed?`${value.slice(0,4)} ${value.slice(4)}`:'•••• ••••'):'';reveal.textContent=revealed?'Hide':'Show';reveal.setAttribute('aria-pressed',String(revealed));}
 reveal.onclick=()=>{revealed=!revealed;showCode();};
 function render(s){state=s;element.querySelector('[data-summary]').textContent=s.custom?'Open all Goals through your Cloudflare Access link, after connecting with an access code.':'Create a link that devices connect to with an access code, to view and reply to all Goals.';toggle.checked=s.enabled;toggle.disabled=!s.local||saving;kind.textContent=s.status==='starting'?'Creating your link and QR…':s.status==='failed'?'Could not create the link.':'';
  box.hidden=!s.url;copy.hidden=!s.url;code.hidden=!s.code;showCode();
  showDevices(s.devices||[]);
  if(s.url){const link=`${s.url}/#/goal/${goalId}`;box.querySelector('a').href=link;box.querySelector('a').textContent=link;box.querySelector('img').src=s.qr;}
  if(s.error)message.textContent=s.error;
  else if(s.status==='failed')message.textContent='Ask your agent to check Public link setup, including the cloudflared tool and the connection. The local page is still available.';
  else if(!s.local)message.textContent='Change public access on the computer running chill-agent.';
  else message.textContent='';
 }
 help.onclick=()=>{info.hidden=!info.hidden;help.setAttribute('aria-expanded',String(!info.hidden));};
 copy.onclick=async()=>{try{await navigator.clipboard.writeText(`${state.url}/#/goal/${goalId}`);message.textContent='Copied';}catch{message.textContent='Copy the link above.';}};
 // A device in the list disconnects alone; Disconnect all clears the list.
 let shownDevices='';
 const when=at=>at?new Date(at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'';
 function showDevices(list){
  const key=JSON.stringify(list);if(key===shownDevices)return;shownDevices=key;
  devices.hidden=!list.length;devices.querySelector('[data-disconnect-all]').hidden=list.length<2;
  const items=list.map(entry=>{const li=document.createElement('li'),name=document.createElement('span'),time=document.createElement('time'),button=document.createElement('button');
   name.textContent=entry.device;time.textContent=when(entry.connectedAt);if(entry.connectedAt)time.dateTime=entry.connectedAt;
   button.type='button';button.textContent='Disconnect';button.setAttribute('aria-label',`Disconnect ${entry.device}`);button.onclick=()=>disconnect('disconnect',{id:entry.id},`Disconnect ${entry.device}?`,'It needs a new access code to open this site again.');
   li.append(name,time,button);return li;});
  devices.querySelector('ul').replaceChildren(...items);
 }
 async function disconnect(path,body,title,detail){
  if(!await confirm({title,message:detail,confirmLabel:'Disconnect'}))return;
  try{await api(path,body);await refresh();message.textContent='Disconnected';}catch(error){if(!signal.aborted)message.textContent=error.message;}
 }
 devices.querySelector('[data-disconnect-all]').onclick=()=>disconnect('disconnect-all',{},'Disconnect all devices?','Each device needs a new access code to open this site again.');
 toggle.onchange=async()=>{
  const enabled=toggle.checked;
  if(enabled&&state.confirmationRequired&&!await confirm({title:'Create public link?',message:'Devices that connect with the code can view and reply to all Goals on this site.',confirmLabel:'Create link'})){toggle.checked=false;return;}
  saving=true;toggle.disabled=true;message.textContent='';kind.textContent=enabled?'Creating your link and QR…':'Closing public access…';
  try{render((await api('toggle',{enabled,confirmPublic:enabled,goalId})));changed();}
  catch(error){if(!signal.aborted){message.textContent=error.message;toggle.checked=state.enabled;}}
  finally{saving=false;toggle.disabled=!state.local;}
 };
 async function refresh(){if(saving||signal.aborted)return;try{render(await api(`state?goalId=${goalId}`));}catch(error){if(!signal.aborted)message.textContent=error.message;}}
 await refresh();const timer=setInterval(refresh,2000);signal.addEventListener('abort',()=>clearInterval(timer),{once:true});return ()=>clearInterval(timer);
}
