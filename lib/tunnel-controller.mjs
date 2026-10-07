import {startTunnel} from './tunnel.mjs';
import {startManagedTunnel} from './managed-tunnel.mjs';

// A replaceable connector; failure closes only the public entrance, not local Web.
export function createTunnelController({start=(process.env.CHILL_AGENT_MANAGED_TUNNEL==='1'?startManagedTunnel:startTunnel),directory,port,onOrigin=()=>{}}){
 let initialized=false,stop=null,revision=0,queue=Promise.resolve(),state={enabled:false,status:'off',url:null,mode:'off',error:null};
 const serial=run=>{const next=queue.then(run);queue=next.catch(()=>{});return next;};
 const clear=async()=>{revision++;onOrigin(null);const previous=stop;stop=null;await previous?.();};
 return {
  get initialized(){return initialized;},
  read:()=>({...state}),
  set(enabled,remote){initialized=true;return serial(async()=>{
   if(enabled&&state.enabled&&['starting','ready'].includes(state.status))return {...state};
   await clear();state={enabled:false,status:'off',url:null,mode:remote?.mode||state.mode,error:null};
   if(!enabled)return {...state};
   const token=revision;state={...state,enabled:true,status:'starting'};
   const fail=error=>{if(token!==revision)return;state={...state,enabled:false,status:'failed',url:null,error:error.message};onOrigin(null);void serial(clear);};
   try{stop=await start({directory,port:port(),remote,
    onOrigin:url=>{if(token===revision){onOrigin(url);state={...state,url,status:url?'ready':state.status};}},onFailure:fail});}
   catch(error){fail(error);}
   return {...state};
  });},
  release(){return serial(async()=>{revision++;const previous=stop;stop=null;if(previous?.release)await previous.release();else await previous?.();});},
  stop(){return serial(async()=>{await clear();state={...state,enabled:false,status:'off',url:null};});},
 };
}
