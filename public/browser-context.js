// A browser-local preference key, never an authentication credential.
export function browserClientId(){
 try{
  let id=localStorage.getItem('chill-client-id');
  // Preserve subscriptions registered before the shared client context existed.
  id ||= localStorage.getItem('chill-web-push-device');
  if(!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id||''))id=crypto.randomUUID();
  localStorage.setItem('chill-client-id',id);return id;
 }catch{return null;}
}
