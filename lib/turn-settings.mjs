import {open} from 'node:fs/promises';

// App Server's Turn omits model/effort. Read only the matching persisted context,
// never substitute the thread's current (next-turn) settings for historical work.
const cache=new Map();
export async function readTurnSettings(path,turnId){
 if(!path||!turnId)return null;
 let file;
 try{
  file=await open(path,'r');const stat=await file.stat();
  const signature=`${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  let entry=cache.get(path);
  if(entry?.signature!==signature){entry={signature,turns:new Map()};cache.set(path,entry);if(cache.size>20)cache.delete(cache.keys().next().value);}
  if(entry.turns.has(turnId))return entry.turns.get(turnId);
  let end=stat.size,tail=Buffer.alloc(0);
  while(end>0){
   const start=Math.max(0,end-256*1024),block=Buffer.alloc(end-start);
   const {bytesRead}=await file.read(block,0,block.length,start);
   const data=Buffer.concat([block.subarray(0,bytesRead),tail]);
   let right=data.length;
   for(let i=data.length-1;i>=0;i--){
    if(data[i]!==10)continue;
    consume(data.subarray(i+1,right));right=i;
   }
   tail=data.subarray(0,right);end=start;
   if(end===0)consume(tail);
   if(entry.turns.has(turnId))return entry.turns.get(turnId);
  }
  entry.turns.set(turnId,null);return null;
  function consume(line){
   // Avoid decoding tool output and other large records; the discriminator is
   // in the JSONL envelope, before the potentially long payload.
   if(!/"type"\s*:\s*"turn_context"/.test(line.subarray(0,256).toString()))return;
   try{const record=JSON.parse(line.toString()),p=record.payload;
    if(record.type!=='turn_context'||!p?.turn_id||entry.turns.has(p.turn_id))return;
    entry.turns.set(p.turn_id,typeof p.model==='string'?{model:p.model,reasoning:typeof p.effort==='string'?p.effort:null}:null);
   }catch{ /* Incomplete last records are retried when the file grows. */ }
  }
 }catch{return null;}finally{await file?.close();}
}
