// Keeps the tab's title and icon live over a WebSocket (lib/live-status.mjs).
// A hidden tab's timers wake about once a minute, but socket messages arrive
// at once. Polling stays as the fallback while the socket is down.
// onUpdate hears chill's update phase; onReach(false) says the socket was lost
// and is retrying, onReach(true) that it is back.
export function createLiveStatus({getGoalId,query=()=>'',onPresence,onSummary,onUpdate=()=>{},onReach=()=>{}}){
  let socket=null,goalId=null,retry=null,delay=1000;
  function open(){
    clearTimeout(retry);retry=null;
    if(socket){socket.onclose=null;socket.close();socket=null;}
    const id=goalId=getGoalId();
    // A page with no socket has nothing to lose: it is not unreachable.
    if(!id||typeof WebSocket!=='function'){onReach(true);return;}
    const ws=socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/api/goals/${id}/live${query()}`);
    ws.onopen=()=>{delay=1000;onReach(true);};
    ws.onmessage=event=>{
      let data;try{data=JSON.parse(event.data);}catch{return;}
      if(id!==getGoalId())return;
      if(data.presence)onPresence(data.presence);
      if(data.summary)onSummary(data.summary,id);
      if(data.update)onUpdate(data.update);
    };
    ws.onclose=()=>{if(socket!==ws)return;socket=null;onReach(false);retry=setTimeout(open,delay);delay=Math.min(delay*2,30000);};
  }
  // Back from the background, sleep, a frozen tab or the back button: reconnect now.
  const reconnect=()=>{if(!socket||socket.readyState>WebSocket.OPEN)open();};
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')reconnect();});
  document.addEventListener('resume',reconnect);
  window.addEventListener('pageshow',event=>{if(event.persisted)open();});
  window.addEventListener('online',open);
  return {
    routeChanged(){if(getGoalId()!==goalId)open();},
    get connected(){return socket?.readyState===WebSocket.OPEN;},
  };
}
