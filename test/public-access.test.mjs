import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicAccess,sessionFrom,deviceName} from '../lib/public-access.mjs';

const memory=()=>{let value=null;return {read:async()=>value,write:async(_,next)=>{value=structuredClone(next);},lock:async(_,run)=>run()};};

test('a code connects one device once; the panel shows the same code until it is used',async()=>{
 const access=createPublicAccess({store:memory()});
 const code=await access.code();
 assert.match(code,/^[0-9]{6}$/);
 assert.equal(await access.code(),code);
 const issued=await access.issued();
 assert.equal(issued.code,code);assert.ok(Date.parse(issued.expiresAt)>Date.now());
 const session=await access.connect(`${code.slice(0,3)} ${code.slice(3)}`,{device:'iPhone · Safari'});
 assert.ok(session);
 assert.equal(await access.connected(session),true);
 assert.equal(await access.connect(code),null,'a used code does not work again');
 assert.notEqual(await access.code(),code);
 assert.equal(await access.connected('not-a-session'),false);
 const [device]=await access.devices();
 assert.equal(device.device,'iPhone · Safari');assert.match(device.id,/^[0-9a-f]{16}$/);assert.ok(device.connectedAt);
});

test('wrong tries and time end a code; a device disconnects alone or with all the others',async()=>{
 let now=Date.parse('2026-10-19T00:00:00Z');
 const access=createPublicAccess({store:memory(),now:()=>now});
 const code=await access.code();
 for(let i=0;i<5;i++)assert.equal(await access.connect('22222222'),null);
 assert.equal(await access.connect(code),null,'five wrong tries end the code');
 const next=await access.code();
 assert.notEqual(next,code);
 now+=10*60*1000;
 assert.equal(await access.connect(next),null,'a code expires after ten minutes');
 const phone=await access.connect(await access.code(),{device:'iPhone · Safari'}),laptop=await access.connect(await access.code(),{device:'Mac · Chrome'});
 await access.disconnect((await access.devices()).find(d=>d.device==='iPhone · Safari').id);
 assert.equal(await access.connected(phone),false);assert.equal(await access.connected(laptop),true,'the other device stays');
 await access.disconnectAll();
 assert.equal(await access.connected(laptop),false);
 assert.deepEqual(await access.devices(),[]);
});

test('the newest connection is the one every page announces',async()=>{
 let now=Date.parse('2026-10-26T07:00:00Z');
 const access=createPublicAccess({store:memory(),now:()=>now});
 assert.equal(await access.newest(),null);
 await access.connect(await access.code(),{device:'iPhone · Safari'});
 now+=60*1000;
 await access.connect(await access.code(),{device:'Mac · Chrome'});
 assert.deepEqual(await access.newest(),{device:'Mac · Chrome',connectedAt:'2026-10-26T07:01:00.000Z'});
});

test('a reset ends the code and keeps connected devices',async()=>{
 const access=createPublicAccess({store:memory()});
 const session=await access.connect(await access.code(),{device:'iPhone · Safari'});
 const code=await access.code();
 await access.resetCode();
 assert.equal(await access.connect(code),null,'the old code no longer connects');
 assert.notEqual(await access.code(),code);
 assert.equal(await access.connected(session),true);
});

test('a device is named by its system and browser',()=>{
 assert.equal(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'),'iPhone · Safari');
 assert.equal(deviceName('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36'),'Android · Chrome');
 assert.equal(deviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0'),'Mac · Edge');
 assert.equal(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0'),'Windows · Firefox');
 assert.equal(deviceName(''),'Unknown device');
});

test('the session is read from its cookie',()=>{
 assert.equal(sessionFrom({headers:{cookie:'a=1; chill_session=abc_-1; b=2'}}),'abc_-1');
 assert.equal(sessionFrom({headers:{}}),'');
});
