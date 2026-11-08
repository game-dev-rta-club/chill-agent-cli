// Pushes each open Goal page's tab state, the agent's presence and the Root's
// Letter summary, over a WebSocket as it changes. A hidden tab's timers wake
// only once a minute, but its WebSocket messages are not throttled, so a tab in
// the background follows the agent within about a second. Polling stays as the
// fallback while the socket is down.
import {WebSocketServer} from 'ws';

const path=/^\/api\/goals\/([1-9][0-9]*)\/live$/;
const clientIdOf=url=>/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(url.searchParams.get('clientId')||'')?url.searchParams.get('clientId'):null;

// read.presence(goalId) and read.summary(goalId,clientId) give what the page
// polls for. read.signature() is a cheap value that changes whenever a summary
// may have; summaries are also recounted every recountMs for what it misses.
export function createLiveStatus({allowed,read,tickMs=1000,pingMs=25000,recountMs=15000}){
  const sockets=new WebSocketServer({noServer:true,maxPayload:1024}),clients=new Set();
  let closed=false,ticking=false,signature,countedAt=0,timer=null,pinger=null;
  const quietly=(promise,fallback)=>promise.catch(()=>fallback);
  function send(client,{presence,summary}){
    const out={};
    if(presence){const text=JSON.stringify(presence);if(text!==client.presence){client.presence=text;out.presence=presence;}}
    if(summary){const text=JSON.stringify(summary);if(text!==client.summary){client.summary=text;out.summary=summary;}}
    if(Object.keys(out).length&&client.socket.readyState===client.socket.OPEN)client.socket.send(JSON.stringify(out));
  }
  // Each tick reads every Goal's presence once, and every count once per device.
  async function tick(){
    if(ticking||closed||!clients.size)return;ticking=true;
    try{
      const now=await quietly(read.signature(),null),recount=now===null||now!==signature||Date.now()-countedAt>=recountMs;
      if(recount){signature=now;countedAt=Date.now();}
      const presences=new Map(),summaries=new Map();
      for(const client of clients){
        if(!presences.has(client.goalId))presences.set(client.goalId,quietly(read.presence(client.goalId),{status:'unknown'}));
        const key=`${client.goalId} ${client.clientId}`;
        if(recount&&!summaries.has(key))summaries.set(key,quietly(read.summary(client.goalId,client.clientId),null));
      }
      for(const client of clients)send(client,{presence:await presences.get(client.goalId),summary:recount?await summaries.get(`${client.goalId} ${client.clientId}`):null});
    }finally{ticking=false;}
  }
  function start(){
    timer??=setInterval(()=>void tick(),tickMs);timer.unref?.();
    // A proxy such as a Cloudflare tunnel closes a silent socket; a missed pong ends a dead one.
    pinger??=setInterval(()=>{for(const client of clients){if(!client.alive){client.socket.terminate();continue;}client.alive=false;client.socket.ping();}},pingMs);pinger.unref?.();
  }
  function refuse(socket,status){if(!socket.destroyed){socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);socket.destroy();}}
  async function upgrade(request,socket,head){
    let url;try{url=new URL(request.url,'http://localhost');}catch{return refuse(socket,'400 Bad Request');}
    const match=path.exec(url.pathname);if(!match)return refuse(socket,'404 Not Found');
    let ok=false;try{ok=!closed&&await allowed(request);}catch{}
    if(!ok||closed)return refuse(socket,'403 Forbidden');
    sockets.handleUpgrade(request,socket,head,ws=>{
      if(closed){ws.terminate();return;}
      const client={socket:ws,goalId:match[1],clientId:clientIdOf(url),alive:true};
      clients.add(client);start();
      ws.on('pong',()=>{client.alive=true;});
      ws.on('close',()=>clients.delete(client));
      ws.on('error',()=>clients.delete(client));
      void Promise.all([quietly(read.presence(client.goalId),{status:'unknown'}),quietly(read.summary(client.goalId,client.clientId),null)])
        .then(([presence,summary])=>send(client,{presence,summary}));
    });
  }
  // Open sockets would hold server.close() open, so stopping Web ends them.
  function close(){
    closed=true;clearInterval(timer);clearInterval(pinger);
    for(const client of clients)client.socket.terminate();
    clients.clear();sockets.close();
  }
  return {upgrade,close,tick,get size(){return clients.size;}};
}
