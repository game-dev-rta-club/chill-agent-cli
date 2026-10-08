import {confirmAction} from './confirmation-dialog.js';

export function createRuntimeUpdate({button,announce=()=>{}}){
 let state=null,busy=false,refreshing=false;
 const label='更新';
 button.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M5.2 8a7.5 7.5 0 0 1 12.4-2.2L20 8M4 16l2.4 2.2A7.5 7.5 0 0 0 18.8 16"/></svg>';
 async function api(body){
  const response=await fetch('/api/runtime-update',{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,cache:'no-store',signal:AbortSignal.timeout(10000)});
  const value=await response.json();if(!response.ok)throw Error(value.error||'更新情報を確認できませんでした。');return value;
 }
 async function refresh(){
  if(refreshing||busy||document.visibilityState!=='visible')return;
  refreshing=true;
  try{state=await api();button.hidden=!state.available;button.disabled=state.phase!=='idle';button.setAttribute('aria-label',label);button.title=label;}
  catch{button.hidden=true;state=null;}
  finally{refreshing=false;}
 }
 button.onclick=async()=>{
  if(busy||!state?.available)return;
  const candidate=state.candidate;
  busy=true;
  try{
   if(!await confirmAction({title:'更新',message:'再起動すると新しいバージョンになります。',confirmLabel:'OK',cancelLabel:'キャンセル'}))return;
   const instance=state.instance;
   button.disabled=true;button.setAttribute('aria-busy','true');announce('再起動中…');
   await api({candidate,id:crypto.randomUUID()});
   // Keep this page and its drafts mounted while the server changes underneath it.
   const deadline=Date.now()+12*60*1000;
   while(Date.now()<deadline){
    await new Promise(resolve=>setTimeout(resolve,1500));
    let result;try{result=await api();}catch{continue;}
    if(result.error)throw Error(result.error);
    if(result.instance!==instance&&!result.available&&result.phase==='idle'){location.reload();return;}
   }
   throw Error('再接続を確認できませんでした。少し待ってページを再読み込みしてください。');
  }catch(error){announce(error.message);}
  finally{busy=false;button.removeAttribute('aria-busy');void refresh();button.focus({preventScroll:true});}
 };
 const timer=setInterval(refresh,15000);
 const visible=()=>void refresh();document.addEventListener('visibilitychange',visible);window.addEventListener('focus',visible);
 void refresh();
 return {refresh,destroy(){clearInterval(timer);document.removeEventListener('visibilitychange',visible);window.removeEventListener('focus',visible);}};
}
