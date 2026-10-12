import test from 'node:test';
import assert from 'node:assert/strict';
import {createNotifications} from '../lib/notifications.mjs';

const profile={enabled:true,tool:'test-send',destination:'chosen-recipient',on:['comment','letter']};
function fixture(previous={enabled:false}) {
 let saved=null,queue=Promise.resolve(),seq=0,currentThread='chat-a';
 const roots=[{id:'1',threadId:'chat-a'},{id:'2',threadId:'chat-b'}],items=[];
 const store={read:async()=>structuredClone(saved),write:async(_,v)=>{saved=structuredClone(v);},lock:(_,fn)=>{const result=queue.then(fn);queue=result.catch(()=>{});return result;}};
 const ctx=async id=>{const root=roots.find(r=>r.id===(id==='3'?'1':id));if(!root)throw Error('Unknown Goal');return {root,goal:{id,title:'Useful outcome'}};};
 const api=createNotifications({store,goals:async()=>roots,context:ctx,events:async()=>items,legacy:async()=>previous,disableLegacy:async()=>{previous={...previous,enabled:false};},url:async()=>null,now:()=>new Date(1700000000000+seq).toISOString(),uuid:()=>`notice-${++seq}`,thread:()=>currentThread,use:async()=>{}});
 const add=(goalId='3',type='comment',text='A verified result')=>{const e={id:items.length+1,goalId,author:'agent',type,text};items.push(e);return e.id;};
 return {api,add,items,roots,state:()=>saved,legacy:()=>previous,thread:v=>currentThread=v};
}

test('migration preserves existing Root preferences but does not enable future Roots or replay old events',async()=>{
 const f=fixture(profile);const old=f.add();
 await f.api.initialize();assert.equal(f.legacy().enabled,false);assert.equal((await f.api.settings('3')).enabled,true);
 f.roots.push({id:'4',threadId:'chat-a'});assert.equal((await f.api.settings('4')).enabled,false);
 assert.equal((await f.api.prepare('3',old)).enabled,false);
 const fresh=f.add();assert.equal((await f.api.prepare('3',fresh)).enabled,true);
});
test('Off retains the connection; enabling a child targets only its Root and never replays Off events',async()=>{
 const f=fixture();await f.api.configure('3',profile);
 await f.api.configure('3',{enabled:false});const old=f.add();
 assert.equal((await f.api.settings('3')).destination,profile.destination);
 await f.api.configure('3',{enabled:true});
 assert.equal((await f.api.settings('1')).enabled,true);assert.equal((await f.api.settings('2')).enabled,false);
 assert.equal((await f.api.prepare('3',old)).enabled,false);
 assert.equal((await f.api.prepare('3',f.add())).enabled,true);
});
test('reads never persist or create events; toggling an unconfigured connection fails without mutation',async()=>{
 const f=fixture();await f.api.control('3',{activity:true});await f.api.settings();assert.equal(f.state(),null);
 await assert.rejects(f.api.configure('3',{enabled:true}),/Set up/);assert.equal(f.state(),null);
});
test('concurrent preparation reserves only one immutable message and never resends after a crash',async()=>{
 const f=fixture();await f.api.configure('1',profile);const event=f.add();
 const results=await Promise.all([f.api.prepare('3',event),f.api.prepare('3',event)]);
 assert.equal(results.filter(r=>r.enabled).length,1);const prepared=results.find(r=>r.enabled);
 f.items[0].text='Changed afterward';
 assert.equal((await f.api.prepare('3',event)).enabled,false);
 const history=(await f.api.control('1',{activity:true})).activity.entries;
 assert.equal(history[0].message,prepared.message);assert.equal(history[0].status,'Unconfirmed');assert.equal(history.length,1);
});
test('result is idempotent, checks assignment and ownership, and means tool acceptance only',async()=>{
 const f=fixture();await f.api.configure('1',profile);const prepared=await f.api.prepare('3',f.add());
 await f.api.result('1',prepared.noticeId,'sent');await f.api.result('3',prepared.noticeId,'sent');
 await assert.rejects(f.api.result('1',prepared.noticeId,'failed'),/different/);
 f.thread('chat-b');await assert.rejects(f.api.result('2',prepared.noticeId,'sent'),/does not belong/);
 assert.equal((await f.api.control('1',{activity:true})).activity.entries[0].status,'Sent');
});
test('disabled state, selected occasions, foreign events and wrong Agent prevent preparation',async()=>{
 const f=fixture();await f.api.configure('1',{...profile,on:['letter']});
 assert.equal((await f.api.prepare('3',f.add())).enabled,false);
 await assert.rejects(f.api.prepare('3',f.add('2','letter')),/not found/);
 f.thread('chat-b');await assert.rejects(f.api.prepare('3',f.add('3','letter')),/assigned/);
 f.thread('chat-a');await f.api.configure('1',{enabled:false});assert.equal((await f.api.prepare('3',f.add('3','letter'))).enabled,false);
});
test('changing one Root connection does not alter another Root or disclose old Agent history',async()=>{
 const f=fixture(profile);await f.api.initialize();const p=await f.api.prepare('3',f.add());
 await f.api.configure('1',{...profile,destination:'new-recipient'});
 assert.equal((await f.api.settings('2')).destination,'chosen-recipient');
 assert.equal((await f.api.settings('1')).destination,'new-recipient');
 f.roots[0].threadId='replacement';assert.equal((await f.api.control('1',{activity:true})).activity.entries.length,0);
 await assert.rejects(f.api.result('1',p.noticeId,'sent'),/assigned/);
});
test('moved Root and malformed settings cannot change configuration',async()=>{
 const f=fixture();await assert.rejects(f.api.configure('3',profile,'2'),/moved/);
 await assert.rejects(f.api.configure('1',{...profile,token:'secret'}),/Unknown/);
 assert.equal(f.state(),null);
});

test('notification receipt command follows the project port',async t=>{
 const {prepareProject,workspacePort}=await import('../lib/project-workspace.mjs');const {mkdtemp,mkdir,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const base=await mkdtemp(join(tmpdir(),'chill-notice-port-')),oldDir=process.env.CHILL_AGENT_DATA_DIR,oldPort=process.env.PORT;
 t.after(async()=>{if(oldDir===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=oldDir;if(oldPort===undefined)delete process.env.PORT;else process.env.PORT=oldPort;await rm(base,{recursive:true,force:true});});
 const project=join(base,'project');await mkdir(project);process.env.CHILL_AGENT_DATA_DIR=await prepareProject(project,{base});delete process.env.PORT;
 const f=fixture();await f.api.configure('1',profile);const result=await f.api.prepare('3',f.add());
 assert.match(result.resultCommand,new RegExp("PORT='"+workspacePort()+"'"));
});
