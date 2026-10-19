import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicAccess,sessionFrom,codeAlphabet} from '../lib/public-access.mjs';

const memory=()=>{let value=null;return {read:async()=>value,write:async(_,next)=>{value=structuredClone(next);},lock:async(_,run)=>run()};};

test('a code signs one phone in once; the panel shows the same code until it is used',async()=>{
 const access=createPublicAccess({store:memory()});
 const code=await access.code();
 assert.match(code,new RegExp(`^[${codeAlphabet}]{8}$`));
 assert.equal(await access.code(),code);
 const session=await access.signIn(`${code.slice(0,4).toLowerCase()} ${code.slice(4)}`);
 assert.ok(session);
 assert.equal(await access.signedIn(session),true);
 assert.equal(await access.signIn(code),null,'a used code does not work again');
 assert.notEqual(await access.code(),code);
 assert.equal(await access.signedIn('not-a-session'),false);
 assert.equal(await access.phones(),1);
});

test('wrong tries and time end a code; signing out removes every phone',async()=>{
 let now=Date.parse('2026-10-19T00:00:00Z');
 const access=createPublicAccess({store:memory(),now:()=>now});
 const code=await access.code();
 for(let i=0;i<5;i++)assert.equal(await access.signIn('22222222'),null);
 assert.equal(await access.signIn(code),null,'five wrong tries end the code');
 const next=await access.code();
 assert.notEqual(next,code);
 now+=10*60*1000;
 assert.equal(await access.signIn(next),null,'a code expires after ten minutes');
 const session=await access.signIn(await access.code());
 await access.signOutAll();
 assert.equal(await access.signedIn(session),false);
 assert.equal(await access.phones(),0);
});

test('the session is read from its cookie',()=>{
 assert.equal(sessionFrom({headers:{cookie:'a=1; chill_session=abc_-1; b=2'}}),'abc_-1');
 assert.equal(sessionFrom({headers:{}}),'');
});
