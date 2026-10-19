import {createHash,randomBytes,randomInt,timingSafeEqual} from 'node:crypto';
import {storage} from './extension-api.mjs';

export const sessionCookie='chill_session';
// Digits and capitals without 0, 1, I and O, which are easy to misread.
export const codeAlphabet='23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const codeLength=8,codeLifetime=10*60*1000,attempts=5;
const newCode=()=>Array.from({length:codeLength},()=>codeAlphabet[randomInt(codeAlphabet.length)]).join('');
const digest=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export const normalCode=value=>String(value||'').toUpperCase().replace(/[\s-]/g,'');

export function sessionFrom(request){
 for(const part of String(request.headers.cookie||'').split(';')){
  const [name,...value]=part.trim().split('=');
  if(name===sessionCookie)return value.join('=');
 }
 return '';
}

// A phone signs in once with the code shown in the Public link panel. A code works
// once, expires, and stops working after a few wrong tries; the phone keeps its
// session until the computer signs every phone out.
export function createPublicAccess({store=storage('public-access'),now=Date.now}={}){
 const read=async()=>({code:null,sessions:[],...await store.read('1')});
 const change=run=>store.lock('1',async()=>{const state=await read();const result=run(state);await store.write('1',state);return result;});
 const fresh=code=>code&&code.expiresAt-now()>60*1000&&code.failures<attempts;
 return {
  async code(){
   const state=await read();
   if(fresh(state.code))return state.code.value;
   return change(state=>{if(!fresh(state.code))state.code={value:newCode(),expiresAt:now()+codeLifetime,failures:0};return state.code.value;});
  },
  async signIn(input){
   const code=normalCode(input);
   if(!code)return null;
   return change(state=>{
    const current=state.code;
    if(!current||current.expiresAt<=now()||current.failures>=attempts)return null;
    if(!same(current.value,code)){current.failures+=1;return null;}
    const session=randomBytes(32).toString('base64url');
    state.code=null;state.sessions.push({hash:digest(session),createdAt:new Date(now()).toISOString()});
    return session;
   });
  },
  async signedIn(session){
   if(!session)return false;
   const hash=digest(session);
   return (await read()).sessions.some(entry=>same(entry.hash,hash));
  },
  async phones(){return (await read()).sessions.length;},
  signOutAll:()=>change(state=>{state.sessions=[];state.code=null;}),
 };
}
