import test from 'node:test';
import assert from 'node:assert/strict';
import {createTunnelController} from '../lib/tunnel-controller.mjs';
test('public access starts once, stops without touching local Web, and ignores old callbacks',async()=>{
 let calls=0,stops=0,callbacks,origin;
 const c=createTunnelController({directory:'/tmp/test',port:()=>1,onOrigin:v=>origin=v,start:async options=>{calls++;callbacks=options;return async()=>{stops++;};}});
 await Promise.all([c.set(true,{mode:'quick'}),c.set(true,{mode:'quick'})]);assert.equal(calls,1);assert.equal(c.read().status,'starting');
 callbacks.onOrigin('https://example.test');assert.equal(c.read().status,'ready');
 await c.set(false);assert.equal(stops,1);assert.equal(origin,null);
 callbacks.onOrigin('https://stale.test');assert.equal(origin,null);assert.equal(c.read().enabled,false);
});
test('connector errors preserve a failed state and can be retried',async()=>{
 let count=0;
 const c=createTunnelController({directory:'/tmp/test',port:()=>1,start:async()=>{if(++count===1)throw Error('Not installed');return async()=>{};}});
 await c.set(true,{mode:'quick'});assert.equal(c.read().status,'failed');assert.equal(c.read().error,'Not installed');
 await c.set(true,{mode:'quick'});assert.equal(c.read().status,'starting');await c.stop();
});

test('an explicit Off from an extension prevents automatic configured startup',async()=>{
 const c=createTunnelController({directory:'/tmp/test',port:()=>1,start:async()=>{throw Error('must not run');}});
 assert.equal(c.initialized,false);await c.set(false,{mode:'named'});assert.equal(c.initialized,true);assert.equal(c.read().status,'off');
});
