import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentSettingsStore} from '../lib/agent-settings.mjs';
import {resolveAgentConnection,connectionKey} from '../lib/agent-connection.mjs';
import {createCodexDesktopConnection} from '../lib/codex-desktop-connection.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function fixture(harnessId='test-harness') {
  let current={model:'provider/first',label:'First',reasoning:'deliberate'};
  const writes=[];
  return {
    writes,
    connection:{harnessId,sessionId:'same-session',
      readSnapshot:async()=>({settings:{...current},models:[
        {id:'provider/first',label:'First',efforts:['deliberate']},
        {id:'provider/second',label:'Second',efforts:['balanced','deep']},
      ]}),
      canSaveSettings:async()=>true,
      saveSettings:async(settings,expected)=>{writes.push({settings,expected});current={model:settings.model,reasoning:settings.effort};return true;},
    },
  };
}
const input=()=>({model:'provider/second',effort:'deep',expected:{model:'provider/first',effort:'deliberate'}});
const current={assertCurrent:async()=>{}};

test('legacy Roots resolve only to their current Codex connection, not from a model name',()=>{
  assert.equal(resolveAgentConnection({model:'claude-opus'}),null);
  const connection=resolveAgentConnection({threadId:'native-thread',model:'claude-opus'});
  assert.equal(connection.harnessId,'codex-desktop');assert.equal(connection.sessionId,'native-thread');
  assert.notEqual(connectionKey({harnessId:'a:b',sessionId:'c'}),connectionKey({harnessId:'a',sessionId:'b:c'}));
});

test('snapshots share in-flight work only within the same harness and session; fresh reads survive an older failure',async()=>{
  const store=createAgentSettingsStore(),first=deferred();let reads=0;
  const a={harnessId:'one',sessionId:'same',readSnapshot:()=>{reads++;return first.promise;}};
  const b={harnessId:'two',sessionId:'same',readSnapshot:async()=>({provider:'two'})};
  const one=store.read(a),also=store.read(a);
  const old=Promise.allSettled([one,also]);
  assert.deepEqual(await store.read(b),{provider:'two'});assert.equal(reads,1);
  a.readSnapshot=async()=>({provider:'one-new'});
  const fresh=await store.read(a,{fresh:true});first.reject(Error('old disconnected'));await old;
  a.readSnapshot=async()=>{throw Error('must use fresh cache');};
  assert.equal(await store.read(a),fresh);assert.deepEqual(await store.read(b),{provider:'two'});
});

test('settings preserve provider choices and expected values without Codex model or effort enums',async()=>{
  const {connection,writes}=fixture(),store=createAgentSettingsStore();let ownerChecks=0;
  const after=await store.save(connection,input(),{assertCurrent:async()=>{ownerChecks++;}});
  assert.equal(after.settings.model,'provider/second');assert.equal(after.settings.reasoning,'deep');
  assert.deepEqual(writes,[{settings:{model:'provider/second',effort:'deep'},expected:{model:'provider/first',effort:'deliberate'}}]);
  assert.equal(ownerChecks,2,'verify ownership before dispatch and after read-back');
});

test('unsupported choices, stale settings, read-only adapters and reassignment cannot write',async()=>{
  for(const kind of ['unsupported','stale','read-only','no-method','reassigned']) {
    const {connection,writes}=fixture(),store=createAgentSettingsStore(),request=input();
    let match;
    if(kind==='unsupported'){request.effort='medium';match=/supported/;}
    if(kind==='stale'){request.expected.effort='balanced';match=/Settings changed/;}
    if(kind==='read-only'){connection.canSaveSettings=async()=>false;match=/read-only/;}
    if(kind==='no-method'){delete connection.saveSettings;match=/read-only/;}
    if(kind==='reassigned')match=/Agent changed/;
    await assert.rejects(store.save(connection,request,{assertCurrent:async()=>{if(kind==='reassigned')throw Error('Agent changed.');}}),match);
    assert.equal(writes.length,0,kind);
  }
});

test('rejected writes and unconfirmed read-back do not report success or retry the write',async()=>{
  for(const outcome of ['rejected','not-applied','disconnected','reassigned']) {
    const {connection}=fixture(),store=createAgentSettingsStore();let writes=0,checks=0;
    connection.saveSettings=async()=>{writes++;return outcome!=='rejected';};
    const read=connection.readSnapshot;
    connection.readSnapshot=async()=>{if(writes&&outcome==='disconnected')throw Error('Disconnected');return read();};
    await assert.rejects(store.save(connection,input(),{assertCurrent:async()=>{checks++;if(checks===2&&outcome==='reassigned')throw Error('Agent changed.');}}),
      outcome==='rejected'?/Could not save/:outcome==='disconnected'?/Disconnected/:outcome==='reassigned'?/Agent changed/:/unconfirmed/);
    assert.equal(writes,1,outcome);
  }
});

test('concurrent saves are rejected for one connection but do not lock another harness',async()=>{
  const {connection}=fixture(),store=createAgentSettingsStore(),wait=deferred();
  const write=connection.saveSettings;connection.saveSettings=async(...args)=>{await wait.promise;return write(...args);};
  const pending=store.save(connection,input(),current);
  await assert.rejects(store.save(connection,input(),current),/Saving/);
  const other=fixture('other-harness');await store.save(other.connection,input(),current);
  wait.resolve();await pending;
  assert.equal(other.writes.length,1);
});

test('Codex adapter normalizes private RPC data, keeps partial failures separate and maps CAS writes',async()=>{
  const calls=[],updates=[],probes=[];
  const connection=createCodexDesktopConnection('thread',{
    run:async action=>action({request:async(method,params)=>{
      calls.push({method,params});
      if(method==='thread/read')return {thread:{id:'thread',model:'native-a',reasoningEffort:'xhigh',privateAccount:'secret'}};
      if(method==='model/list')return {data:[{id:'catalog-a',model:'native-a',displayName:'Model A',supportedReasoningEfforts:[{reasoningEffort:'xhigh'}],defaultReasoningEffort:'xhigh'},{id:'hidden',hidden:true}]};
      if(method==='account/rateLimits/read')throw Error('Usage offline');
      if(method==='thread/queue/list')return {data:[{clientUserMessageId:'message',input:'private prompt'}],nextCursor:null};
      throw Error('Unexpected RPC');
    }}),
    canSave:async(...args)=>{probes.push(args);return true;},
    update:async(...args)=>{updates.push(args);return {applied:true};},canControl:async()=>false,
  });
  const snapshot=await connection.readSnapshot();
  assert.deepEqual(snapshot.settings,{model:'native-a',label:'Model A',reasoning:'xhigh'});
  assert.deepEqual(snapshot.models,[{id:'native-a',label:'Model A',efforts:['xhigh'],defaultEffort:'xhigh'}]);
  assert.equal(snapshot.usage,null);assert.deepEqual(snapshot.queue,{truncated:false,items:[{messageId:'message'}]});
  assert.doesNotMatch(JSON.stringify(snapshot),/secret|private prompt|catalog-a|hidden/);
  assert.equal(await connection.canSaveSettings(snapshot),true);
  assert.deepEqual(probes,[['thread',{model:'native-a',effort:'xhigh'}]]);
  const settings={model:'native-b',effort:'high'},expected={model:'native-a',effort:'xhigh'};
  assert.equal(await connection.saveSettings(settings,expected),true);assert.deepEqual(updates,[['thread',settings,expected]]);
  assert.equal(await connection.canControl(),false);assert.equal(calls.length,4);
});

test('Codex adapter rejects a snapshot belonging to a different conversation',async()=>{
  const connection=createCodexDesktopConnection('wanted',{run:async action=>action({request:async method=>method==='thread/read'?{thread:{id:'other'}}:{data:[]}})});
  await assert.rejects(connection.readSnapshot(),/assignment changed/);
});
