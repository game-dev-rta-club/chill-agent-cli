const bytes=key=>Uint8Array.from(atob(key.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-key.length%4)%4)),c=>c.charCodeAt(0));
export async function mount({element,control,goalId,clientId:deviceId,api,changed,signal}){
 if(!deviceId){element.textContent='Allow site storage to set up notifications.';return;}
 element.innerHTML=`<label class="agent-extension"><span>On / Off</span><input type="checkbox" role="switch" aria-label="Notifications" disabled></label><p class="extension-message" data-scope hidden>On for this device</p><p class="extension-message" role="status"></p>`;
 const toggle=element.querySelector('input'),message=element.querySelector('[role="status"]'),scope=element.querySelector('[data-scope]');
 const ios=/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
 const supported=isSecureContext&&'Notification' in window&&'serviceWorker' in navigator&&'PushManager' in window;
 let registration,state,saving=false;
 function render(s){state=s;toggle.checked=s.enabled;toggle.disabled=saving;scope.hidden=!s.enabled;}
 async function refresh(){if(saving||signal.aborted)return;try{render(await api('state',{goalId,deviceId}));}catch(error){if(!signal.aborted)message.textContent=error.message;}}
 await refresh();if(!state||signal.aborted)return;
 toggle.onchange=async()=>{
  const enabled=toggle.checked;
  if(enabled&&ios&&!matchMedia('(display-mode: standalone)').matches&&!navigator.standalone){toggle.checked=false;message.textContent='Add to Home Screen, then open Chill and turn notifications on.';return;}
  if(enabled&&!supported){toggle.checked=false;message.textContent='Use a browser that supports notifications, such as Chrome on Android.';return;}
  // Ask within the tap; service-worker setup and network requests follow it.
  const permission=enabled?Notification.requestPermission():Promise.resolve('granted');
  saving=true;toggle.disabled=true;message.textContent='';
  try{
   const result=await permission;
   if(result!=='granted')throw Error(result==='denied'?'Allow notifications in your browser’s site settings, then try On again.':'Notifications were not enabled. You can try On again.');
   let subscription=null;
   if(enabled){
    registration=await navigator.serviceWorker.register('/extensions/web-notifications/sw.js',{scope:'/'});
    const worker=registration.installing||registration.waiting;
    if(!registration.active&&worker)await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Notification setup timed out. Try On again.')),12000);worker.addEventListener('statechange',()=>{if(worker.state==='activated'){clearTimeout(timeout);resolve();}if(worker.state==='redundant'){clearTimeout(timeout);reject(Error('Notification setup failed. Reload to retry.'));}});});
    subscription=await registration.pushManager.getSubscription()||await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes(state.publicKey)});
   }
   if(signal.aborted)return;
   render(await api('toggle',{goalId,rootId:control.rootId,enabled,deviceId,subscription:subscription?.toJSON()}));
   message.textContent=enabled?'A confirmation will arrive shortly.':'';changed();
  }catch(error){if(!signal.aborted){toggle.checked=state.enabled;message.textContent=error.message;}}
  finally{saving=false;toggle.disabled=false;}
 };
 const timer=setInterval(refresh,2500);signal.addEventListener('abort',()=>clearInterval(timer),{once:true});return ()=>clearInterval(timer);
}
