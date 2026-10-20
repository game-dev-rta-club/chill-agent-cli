import {createHash,randomBytes,randomInt,timingSafeEqual} from 'node:crypto';
import {storage} from './extension-api.mjs';

export const sessionCookie='chill_session';
// Six digits, as for one-time codes: a code exists only while the computer's
// panel shows it, and five wrong tries end it.
const codeLength=6,codeLifetime=10*60*1000,attempts=5;
const newCode=()=>String(randomInt(10**codeLength)).padStart(codeLength,'0');
const digest=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export const normalCode=value=>String(value||'').replace(/[\s-]/g,'');

export function sessionFrom(request){
 for(const part of String(request.headers.cookie||'').split(';')){
  const [name,...value]=part.trim().split('=');
  if(name===sessionCookie)return value.join('=');
 }
 return '';
}

// A short name for the connected list, from the browser's User-Agent.
const systems=[['iPhone','iPhone'],['iPad','iPad'],['Android','Android'],['Macintosh','Mac'],['Windows','Windows'],['CrOS','ChromeOS'],['Linux','Linux']];
const browsers=[['Edg/','Edge'],['FxiOS','Firefox'],['Firefox/','Firefox'],['CriOS','Chrome'],['Chrome/','Chrome'],['Safari/','Safari']];
export function deviceName(agent=''){
 const pick=list=>list.find(([key])=>agent.includes(key))?.[1];
 return [pick(systems),pick(browsers)].filter(Boolean).join(' · ')||'Unknown device';
}

// A device connects once with the access code shown in the Public link panel. A
// code works once, expires, and stops working after a few wrong tries; the device
// stays connected until the computer disconnects it.
export function createPublicAccess({store=storage('public-access'),now=Date.now}={}){
 const read=async()=>({code:null,sessions:[],...await store.read('1')});
 const change=run=>store.lock('1',async()=>{const state=await read();const result=run(state);await store.write('1',state);return result;});
 const fresh=code=>code&&code.expiresAt-now()>60*1000&&code.failures<attempts;
 // The panel names a device by the start of its session hash, which reveals nothing.
 const idOf=entry=>entry.hash.slice(0,16);
 return {
  async code(){
   const state=await read();
   if(fresh(state.code))return state.code.value;
   return change(state=>{if(!fresh(state.code))state.code={value:newCode(),expiresAt:now()+codeLifetime,failures:0};return state.code.value;});
  },
  async connect(input,{device='Unknown device'}={}){
   const code=normalCode(input);
   if(!code)return null;
   return change(state=>{
    const current=state.code;
    if(!current||current.expiresAt<=now()||current.failures>=attempts)return null;
    if(!same(current.value,code)){current.failures+=1;return null;}
    const session=randomBytes(32).toString('base64url');
    state.code=null;state.sessions.push({hash:digest(session),device,connectedAt:new Date(now()).toISOString()});
    return session;
   });
  },
  async connected(session){
   if(!session)return false;
   const hash=digest(session);
   return (await read()).sessions.some(entry=>same(entry.hash,hash));
  },
  async devices(){return (await read()).sessions.map(entry=>({id:idOf(entry),device:entry.device||'Unknown device',connectedAt:entry.connectedAt||null}));},
  disconnect:id=>change(state=>{state.sessions=state.sessions.filter(entry=>idOf(entry)!==id);}),
  disconnectAll:()=>change(state=>{state.sessions=[];state.code=null;}),
 };
}
