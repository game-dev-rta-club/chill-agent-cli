import QRCode from 'qrcode';
import {storage,readMessageSettings,saveMessageSetting,touch,readGoalContext,requireProtocol} from './extension-api.mjs';
requireProtocol(1);
// The panel's saved On/Off. Without one, a configured connection starts On.
export const publicLinkOn=async(store=storage('public-link'))=>(await store.read('1'))?.enabled!==false;
export const linkQr=link=>QRCode.toDataURL(link,{width:240,margin:2,color:{dark:'#34483eff',light:'#fffdf9ff'}});
export function createExtension({tunnel,access,configured=false,store=storage('public-link'),context=readGoalContext,settings=readMessageSettings,save=saveMessageSetting,use=touch}={}){
 const asset=(name,type)=>({file:new URL(`../extensions/public-link/${name}`,import.meta.url),type});
 async function read(){const {remote}=await settings(),saved=await store.read('1'),live=tunnel.read();return {...live,confirmationRequired:remote.mode!=='named'&&!saved?.confirmedPublic,custom:(live.enabled?live.mode:remote.mode)==='named',customUrl:remote.mode==='named'?remote.url:null};}
 return {id:'public-link',label:'Public link',
  assets:{'panel.js':asset('panel.js','text/javascript; charset=utf-8'),'guide.html':asset('guide.html','text/html; charset=utf-8'),'notifications.html':asset('notifications.html','text/html; charset=utf-8'),'guide.css':asset('guide.css','text/css; charset=utf-8')},
  async start(){
   const state=await store.read('1');if(!configured||!state)return;
   const {remote}=await settings();await tunnel.set(state.enabled,remote.mode==='off'?{mode:'quick'}:remote);
  },
  async read(goalId){const {root}=await context(goalId),s=await read();return {rootId:root.id,enabled:s.enabled,placement:'header',menu:false,icon:'globe',panelModule:'/extensions/public-link/panel.js',description:'Create a public link and QR for this workspace.'};},
  async set(){throw Error('Use the Public link panel on this computer.');},
  async request({method,path,body,query={},local}){
   if(method==='POST'&&path==='toggle'){
    if(!local)throw Error('Change public access on the computer running chill-agent.');
    if(typeof body.enabled!=='boolean')throw Error('Choose On or Off.');
    await store.lock('1',async()=>{
     let {remote}=await settings();const saved=await store.read('1')||{};
     if(body.enabled&&remote.mode==='off')remote={mode:'quick'};
     if(body.enabled&&remote.mode==='quick'&&!saved.confirmedPublic&&body.confirmPublic!==true)throw Error('Confirm that devices connected with the code can view and reply to all Goals.');
     if(body.enabled)await save('remote',remote);
     await tunnel.set(body.enabled,remote);await store.write('1',{...saved,enabled:body.enabled,confirmedPublic:saved.confirmedPublic||remote.mode==='quick'&&body.confirmPublic===true});await use();
    });
    await access.resetCode();
   }else if(method==='POST'&&['disconnect','disconnect-all'].includes(path)){
    if(!local)throw Error('Disconnect devices on the computer running chill-agent.');
    if(path==='disconnect-all')await access.disconnectAll();
    else{if(typeof body.id!=='string')throw Error('Choose a device.');await access.disconnect(body.id);}
   }else if(method!=='GET'||path!=='state')return {status:404,body:{error:'Not found.'}};
   const state=await read();
   const goalId=body.goalId||query.goalId;
   const goal=/^[1-9][0-9]*$/.test(String(goalId))?goalId:null;
   const link=state.url?`${state.url}/${goal?`#/goal/${goal}`:''}`:null;
   // The QR opens the link only; the device types the code, which only the computer sees.
   const code=link&&local?await access.code():null;
   return {body:{...state,local,link,code,devices:code?await access.devices():null,qr:link?await linkQr(link):null}};
  },
 };
}
