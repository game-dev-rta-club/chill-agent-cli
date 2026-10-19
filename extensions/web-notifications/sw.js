self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
const receipt=(data,kind)=>fetch('/api/extensions/web-notifications/receipt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:data.id,receipt:data.receipt,kind})}).catch(()=>{});
self.addEventListener('push',event=>event.waitUntil((async()=>{
 let data;try{data=event.data.json();}catch{return;}
 const url=new URL(data.url,self.location.origin);if(url.origin!==self.location.origin)return;
 await self.registration.showNotification(String(data.title||'chill-agent').slice(0,120),{body:String(data.body||'').slice(0,400),icon:'/extensions/web-notifications/icon-192.png',badge:'/extensions/web-notifications/icon-192.png',tag:data.id,data:{...data,url:url.href}});
 await receipt(data,'received');
})()));
self.addEventListener('notificationclick',event=>{
 event.notification.close();const data=event.notification.data;
 event.waitUntil((async()=>{
  const url=new URL(data.url,self.location.origin);if(url.origin!==self.location.origin)return;
  const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  const existing=windows.find(c=>new URL(c.url).origin===url.origin);
  if(existing){await existing.navigate(url.href);await existing.focus();}else await self.clients.openWindow(url.href);
  await receipt(data,'clicked');
 })());
});
