import {confirmAction} from './confirmation-dialog.js';

export function createRuntimeUpdate({button,announce=()=>{}}){
 let state=null,busy=false,refreshing=false,soon;
 const label='Update';
 // The button names the running step, on every open page and device, so a
 // download and install of a few minutes never looks like nothing happened.
 const phases={preparing:'Updating…',restarting:'Restarting…'};
 button.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 12a8.5 8.5 0 1 1-2.5-6l2.5 2.5"/><path d="M20.5 3.5v5h-5"/></svg><span>Update</span>';
 function show(phase){
  const text=phases[phase]||label;
  button.querySelector('span').textContent=text;button.title=text;button.setAttribute('aria-label',text);
  if(phases[phase]){button.hidden=false;button.disabled=true;button.setAttribute('aria-busy','true');}else button.removeAttribute('aria-busy');
 }
 async function api(body){
  const response=await fetch('/api/runtime-update',{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,cache:'no-store',signal:AbortSignal.timeout(10000)});
  const value=await response.json();if(!response.ok)throw Error(value.error||'Could not check for an update.');return value;
 }
 async function refresh(){
  if(refreshing||busy||document.visibilityState!=='visible')return;
  refreshing=true;
  const updating=Boolean(phases[state?.phase]);
  try{state=await api();button.hidden=!state.available;button.disabled=state.phase!=='idle';show(state.phase);}
  // A page that saw an update start keeps showing it while Web restarts.
  catch{if(updating){state={...state,phase:'restarting'};show('restarting');}else{button.hidden=true;state=null;show('idle');}}
  finally{refreshing=false;clearTimeout(soon);if(phases[state?.phase])soon=setTimeout(refresh,2000);}
 }
 button.onclick=async()=>{
  if(busy||!state?.available)return;
  const candidate=state.candidate;
  busy=true;
  try{
   if(!await confirmAction({title:'Update',message:'chill restarts with the new version.',confirmLabel:'OK',cancelLabel:'Cancel'}))return;
   const instance=state.instance;
   show('preparing');announce('Updating. This can take a few minutes; chill restarts when the new version is ready.');
   await api({candidate,id:crypto.randomUUID()});
   // Keep this page and its drafts mounted while the server changes underneath it.
   const deadline=Date.now()+12*60*1000;
   while(Date.now()<deadline){
    await new Promise(resolve=>setTimeout(resolve,1500));
    // No answer means Web is between the old and new version.
    let result;try{result=await api();}catch{show('restarting');continue;}
    if(result.error)throw Error(result.error);
    if(phases[result.phase])show(result.phase);
    if(result.instance!==instance&&!result.available&&result.phase==='idle'){location.reload();return;}
   }
   throw Error('Could not reconnect. Wait a moment, then reload the page.');
  }catch(error){announce(error.message);}
  finally{busy=false;button.removeAttribute('aria-busy');void refresh();button.focus({preventScroll:true});}
 };
 const timer=setInterval(refresh,15000);
 const visible=()=>void refresh();document.addEventListener('visibilitychange',visible);window.addEventListener('focus',visible);
 void refresh();
 return {refresh,destroy(){clearInterval(timer);clearTimeout(soon);document.removeEventListener('visibilitychange',visible);window.removeEventListener('focus',visible);}};
}
