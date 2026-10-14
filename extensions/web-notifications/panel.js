const bytes=key=>Uint8Array.from(atob(key.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-key.length%4)%4)),c=>c.charCodeAt(0));
// Two switches per device, always visible so Off still shows what each would send.
const kinds=[['letters','Letters','Questions that need your answer'],['replies','Replies','Other replies from the agent']];
export async function mount({element,control,goalId,clientId:deviceId,api,changed,signal}){
 if(!deviceId){element.textContent='Allow site storage to set up notifications.';return;}
 element.innerHTML=`${kinds.map(([id,label,detail])=>`<label class="agent-extension"><span>${label}</span><input type="checkbox" role="switch" data-kind="${id}" aria-label="${label}: ${detail}" disabled></label><p class="extension-message">${detail}</p>`).join('')}<p class="extension-message" role="status"></p>`;
 const switches=Object.fromEntries([...element.querySelectorAll('[data-kind]')].map(input=>[input.dataset.kind,input])),message=element.querySelector('[role="status"]');
 const ios=/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
 const supported=isSecureContext&&'Notification' in window&&'serviceWorker' in navigator&&'PushManager' in window;
 let registration,state,saving=false;
 function render(s){state=s;for(const [id,input] of Object.entries(switches)){input.checked=Boolean(s[id]);input.disabled=saving;}}
 async function refresh(){if(saving||signal.aborted)return;try{render(await api('state',{goalId,deviceId}));}catch(error){if(!signal.aborted)message.textContent=error.message;}}
 await refresh();if(!state||signal.aborted)return;
 async function register(next){
  if(ios&&!matchMedia('(display-mode: standalone)').matches&&!navigator.standalone)throw Error('Add to Home Screen, then open Chill and turn notifications on.');
  if(!supported)throw Error('Use a browser that supports notifications, such as Chrome on Android.');
  // Ask within the tap; service-worker setup and network requests follow it.
  const result=await Notification.requestPermission();
  if(result!=='granted')throw Error(result==='denied'?'Allow notifications in your browser’s site settings, then try again.':'Notifications were not enabled. You can try again.');
  registration=await navigator.serviceWorker.register('/extensions/web-notifications/sw.js',{scope:'/'});
  const worker=registration.installing||registration.waiting;
  if(!registration.active&&worker)await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Notification setup timed out. Try again.')),12000);worker.addEventListener('statechange',()=>{if(worker.state==='activated'){clearTimeout(timeout);resolve();}if(worker.state==='redundant'){clearTimeout(timeout);reject(Error('Notification setup failed. Reload to retry.'));}});});
  const subscription=await registration.pushManager.getSubscription()||await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes(state.publicKey)});
  if(signal.aborted)return null;
  return api('toggle',{goalId,rootId:control.rootId,enabled:true,deviceId,subscription:subscription.toJSON(),...next});
 }
 for(const [id,input] of Object.entries(switches))input.onchange=async()=>{
  const next={letters:state.letters,replies:state.replies,[id]:input.checked};
  saving=true;for(const s of Object.values(switches))s.disabled=true;message.textContent='';
  try{
   // The first switch On registers this device; the last switch Off turns it off.
   const result=!state.enabled?await register(next):await api('kinds',{goalId,rootId:control.rootId,deviceId,...next});
   if(!result||signal.aborted)return;
   const first=!state.enabled&&result.enabled;render(result);
   message.textContent=first?'A confirmation will arrive shortly.':'';changed();
  }catch(error){if(!signal.aborted){input.checked=Boolean(state[id]);message.textContent=error.message;}}
  finally{saving=false;if(state)render(state);}
 };
 const timer=setInterval(refresh,2500);signal.addEventListener('abort',()=>clearInterval(timer),{once:true});return ()=>clearInterval(timer);
}
