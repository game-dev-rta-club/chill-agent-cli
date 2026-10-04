// Desktop's versioned internal IPC. Keep this optional adapter separate from App Server.
import net from 'node:net';
import {lstat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export async function withDesktopIPC(fn,{platform=process.platform,path=join(process.env.CODEX_HOME||join(homedir(),'.codex'),'ipc','ipc.sock')}={}) {
 if(platform!=='darwin')throw Error('Desktop settings unavailable');
 for(const [file,socket] of [[join(path,'..'),false],[path,true]]){
  const s=await lstat(file);if(s.uid!==process.getuid?.()||(s.mode&0o022)||!(socket?s.isSocket():s.isDirectory()))throw Error('Invalid Desktop IPC endpoint');
 }
 const socket=net.connect(path),pending=new Map();let buffer=Buffer.alloc(0),client='initializing-client';
 const fail=error=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();};
 socket.on('error',fail);socket.on('close',()=>fail(Error('Desktop disconnected')));
 socket.on('data',chunk=>{try{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=4){const size=buffer.readUInt32LE();if(size>8*1024*1024)throw Error('Invalid IPC frame');if(buffer.length<size+4)break;const m=JSON.parse(buffer.subarray(4,size+4));buffer=buffer.subarray(size+4);const p=pending.get(m.requestId);if(m.type==='response'&&p){pending.delete(m.requestId);clearTimeout(p.timer);m.resultType==='success'?p.resolve(m):p.reject(Error('Desktop settings unavailable'));}}}catch(e){fail(e);socket.destroy();}});
 function request(method,params,version){return new Promise((resolve,reject)=>{const requestId=randomUUID(),timer=setTimeout(()=>{pending.delete(requestId);reject(Error('Desktop request timed out'));},4000);pending.set(requestId,{resolve,reject,timer});const body=Buffer.from(JSON.stringify({type:'request',requestId,sourceClientId:client,version,method,params})),header=Buffer.alloc(4);header.writeUInt32LE(body.length);socket.write(Buffer.concat([header,body]));});}
 try{const init=await request('initialize',{clientType:'chill-agent'},0);client=init.result?.clientId;if(!client)throw Error('Invalid Desktop handshake');return await fn(async(method,params,version)=>(await request(method,params,version)).result);}
 finally{socket.destroy();fail(Error('Desktop connection closed'));}
}
export async function canUpdateDesktopSettings(threadId,settings){
 try{return await withDesktopSettings(async update=>{
  // A deliberately unmatched condition probes the method/version without changing settings.
  const r=await update(threadId,settings,{ifModelEquals:`chill-probe-${randomUUID()}`});return r?.applied===false;
 });}catch{return false;}
}
export async function updateDesktopSettings(threadId,settings,expected){
 return withDesktopSettings(update=>update(threadId,settings,{ifModelEquals:expected.model,ifEffortEquals:expected.effort}));
}

export const withDesktopSettings=(fn,options)=>withDesktopIPC(request=>fn((threadId,settings,condition)=>request('thread-follower-update-thread-settings',{conversationId:threadId,threadSettings:settings,condition},2)),options);
export const interruptDesktopTurn=(threadId,turnId)=>withDesktopIPC(request=>request('thread-follower-interrupt-turn',{conversationId:threadId,mode:'user-stop',expectedTurnId:turnId},4));
export async function canControlDesktop(threadId){try{const r=await interruptDesktopTurn(threadId,randomUUID());return r?.ok===true&&r.interruptedTurnId===null;}catch{return false;}}
// IPC reaches Desktop's UI state before App Server applies UserInput defaults.
// Its renderer requires text_elements even for plain text (an empty array).
export const resumeDesktopTurn=(threadId,input,clientUserMessageId,options)=>withDesktopIPC(request=>request('thread-follower-start-turn',{conversationId:threadId,turnStart:{request:{threadId,input:[{type:'text',text:input,text_elements:[]}],clientUserMessageId},context:{inheritThreadSettings:true,attachments:[],commentAttachments:[]}}},2),options);
