self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
const receipt=(data,kind)=>fetch('/api/extensions/web-notifications/receipt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:data.id,receipt:data.receipt,kind})}).catch(()=>{});
self.addEventListener('push',event=>event.waitUntil((async()=>{
 let data;try{data=event.data.json();}catch{return;}
 const url=new URL(data.url,self.location.origin);if(url.origin!==self.location.origin)return;
 await self.registration.showNotification(String(data.title||'chill-agent').slice(0,120),{body:String(data.body||'').slice(0,400),icon:'/extensions/web-notifications/icon-192.png',badge:'/extensions/web-notifications/icon-192.png',tag:data.id,data:{...data,url:url.href}});
 await receipt(data,'received');
})()));
// Ask a tab which Goal and Root it shows; a tab that does not answer in time is skipped.
const ask=client=>new Promise(resolve=>{
 const channel=new MessageChannel(),timer=setTimeout(()=>resolve(null),400);
 channel.port1.onmessage=event=>{clearTimeout(timer);resolve(event.data);};
 try{client.postMessage({type:'chill-where'},[channel.port2]);}catch{clearTimeout(timer);resolve(null);}
});
// Open the Goal in a tab of the same Root: one already showing that Goal, else
// the one used last. With none, open a new tab rather than replace another Root.
async function openGoal(data){
 const url=new URL(data.url,self.location.origin);if(url.origin!==self.location.origin)return false;
 const windows=(await self.clients.matchAll({type:'window',includeUncontrolled:true})).filter(c=>new URL(c.url).origin===url.origin);
 const answers=await Promise.all(windows.map(ask)),goalId=/^#\/goal\/([1-9][0-9]*)/.exec(url.hash)?.[1];
 const tabs=windows.filter((client,i)=>data.rootId&&String(answers[i]?.rootId)===String(data.rootId));
 const tab=tabs.find(client=>String(answers[windows.indexOf(client)].goalId)===goalId)||tabs[0];
 if(tab){tab.postMessage({type:'chill-open',url:url.href});await tab.focus();}else await self.clients.openWindow(url.href);
 return true;
}
self.addEventListener('notificationclick',event=>{
 event.notification.close();const data=event.notification.data;
 event.waitUntil(openGoal(data).then(opened=>opened&&receipt(data,'clicked')));
});
