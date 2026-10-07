// Trusted modules register data-only controls. The host owns scheduling and lifetime.
export function createExtensionHost(extensions, {intervalMs=30000,onError=console.error}={}) {
 const ids=new Set();
 for(const extension of extensions){
  if(!/^[a-z][a-z0-9-]*$/.test(extension.id)||ids.has(extension.id))throw Error('Invalid or duplicate extension ID');
  ids.add(extension.id);
 }
 let stopped=false,timer=null,running=null,changes=0;
 async function tick(){
  if(stopped)return;
  if(running)return running;
  running=(async()=>{for(const e of extensions){if(stopped)break;try{await e.tick?.();}catch(error){onError(error);}}})();
  try{await running;}finally{running=null;}
 }
 return {
  get active(){return Boolean(running)||changes>0;},
  async start(){for(const e of extensions)await e.start?.();if(stopped)return;timer=setInterval(()=>void tick(),intervalMs);timer.unref();void tick();},
  async stop(){stopped=true;clearInterval(timer);await running;for(const e of [...extensions].reverse())await e.stop?.();},
  tick,
  asset(path){
   for(const e of extensions){
    const prefix=`/extensions/${e.id}/`;
    if(path.startsWith(prefix))return e.assets?.[path.slice(prefix.length)]||null;
   }
   return null;
  },
  async request(id,input){
   if(stopped)throw Error('Server is shutting down.');
   const e=extensions.find(e=>e.id===id);if(!e?.request)return {status:404,body:{error:'Not found.'}};
   changes++;
   try{return await e.request(input);}finally{changes--;}
  },
  async controls(goalId,{activity=false,clientId=null}={}){return (await Promise.all(extensions.map(async e=>{const state=await e.read(goalId,{activity,clientId});return state?{id:e.id,label:e.label,...state}:null;}))).filter(Boolean);},
  async change(goalId,id,input,options){
   if(stopped)throw Error('Server is shutting down.');
   const e=extensions.find(e=>e.id===id);if(!e)throw Error('Unknown extension');
   if(typeof input.enabled!=='boolean')throw Error('enabled must be a boolean');
   changes++;
   try{await e.set(goalId,input);return await this.controls(goalId,options);}finally{changes--;}
  },
  async busy(){if(running)return true;for(const e of extensions)if(await e.busy?.())return true;return false;},
 };
}
