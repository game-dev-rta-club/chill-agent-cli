import {confirmAction} from './confirmation-dialog.js';

// Public link: a device that connects with an access code is announced at once on
// every open page, so one nobody expected is noticed. A browser that opens the
// page for the first time takes the newest connection as seen.
const seenKey='chill.newestDevice';
export function newDeviceToShow(newest,seen){
 if(!newest?.connectedAt||newest.connectedAt===seen)return null;
 return seen===null?null:newest;
}
export function watchNewDevices({interval=5000,storage=localStorage,read=()=>fetch('/api/devices/newest',{cache:'no-store'}).then(r=>r.ok?r.json():{})}={}){
 let showing=false;
 async function check(){
  if(showing)return;
  const {newest}=await read().catch(()=>({}));
  if(!newest?.connectedAt)return;
  const shown=newDeviceToShow(newest,storage.getItem(seenKey));
  storage.setItem(seenKey,newest.connectedAt);
  if(!shown)return;
  showing=true;
  const at=new Date(shown.connectedAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  await confirmAction({title:'New device connected',message:`${shown.device} connected with an access code at ${at}. If you do not know this device, disconnect it in Public link on the computer running chill-agent.`,confirmLabel:'OK',cancelLabel:null});
  showing=false;
 }
 check();const timer=setInterval(check,interval);
 return ()=>clearInterval(timer);
}
