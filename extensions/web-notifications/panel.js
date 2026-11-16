const bytes=key=>Uint8Array.from(atob(key.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-key.length%4)%4)),c=>c.charCodeAt(0));
// In the Notification menu's top row: this browser's one Notification switch.
export async function mount({element,control,goalId,clientId:deviceId,api,changed,signal}){
 if(!deviceId){element.textContent='Allow site storage to set up notifications.';return null;}
 element.innerHTML=`<label class="agent-extension letters-notify"><input type="checkbox" role="switch" aria-label="Notification: send what the count shows to this browser"></label><p class="extension-message" role="status"></p>`;
 const input=element.querySelector('input'),message=element.querySelector('[role="status"]');
 const ios=/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
 const supported=isSecureContext&&'Notification' in window&&'serviceWorker' in navigator&&'PushManager' in window;
 let saving=false;
 function render(next){control=next;input.checked=Boolean(next.enabled);input.disabled=saving||!next.letters&&!next.replies;}
 async function subscribe(){
  if(ios&&!matchMedia('(display-mode: standalone)').matches&&!navigator.standalone)throw Error('Add to Home Screen, then open Chill and turn notifications on.');
  if(!supported)throw Error('Use a browser that supports notifications, such as Chrome on Android.');
  // Ask within the tap; service-worker setup and network requests follow it.
  const result=await Notification.requestPermission();
  if(result!=='granted')throw Error(result==='denied'?'Allow notifications in your browser’s site settings, then try again.':'Notifications were not enabled. You can try again.');
  const registration=await navigator.serviceWorker.register('/extensions/web-notifications/sw.js',{scope:'/'});
  const worker=registration.installing||registration.waiting;
  if(!registration.active&&worker)await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Notification setup timed out. Try again.')),12000);worker.addEventListener('statechange',()=>{if(worker.state==='activated'){clearTimeout(timeout);resolve();}if(worker.state==='redundant'){clearTimeout(timeout);reject(Error('Notification setup failed. Reload to retry.'));}});});
  return await registration.pushManager.getSubscription()||await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes(control.publicKey)});
 }
 input.onchange=async()=>{
  const on=input.checked;
  saving=true;input.disabled=true;message.textContent='';
  try{
   const subscription=on?await subscribe():null;
   if(signal.aborted)return;
   const result=await api('toggle',{goalId,rootId:control.rootId,enabled:on,deviceId,...(subscription?{subscription:subscription.toJSON()}:{})});
   if(signal.aborted)return;
   control={...control,...result};
   if(on)message.textContent='A confirmation will arrive shortly.';
   changed();
  }catch(error){if(!signal.aborted)message.textContent=error.message;}
  finally{saving=false;render(control);}
 };
 render(control);
 return {update:render};
}
