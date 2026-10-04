#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
if (process.argv.includes('--version')) { console.log('codex-cli 0.158.0-test'); process.exit(0); }
const root = process.env.CHILL_AGENT_DATA_DIR;
await mkdir(root, {recursive: true});
const path = join(root, 'fake-queue.json');
let queue=[];
try { queue=JSON.parse(await readFile(path,'utf8')); } catch {}
let chain=Promise.resolve();
createInterface({input:process.stdin}).on('line', line=>{
  chain=chain.then(async()=>{
    const request=JSON.parse(line);
    if(request.id===undefined)return;
    await appendFile(join(root,'fake-requests.jsonl'),JSON.stringify(request)+'\n');
    let result={};
    if(request.method==='initialize') result={userAgent:'Fake Codex'};
    else if(request.method==='thread/read') {
      if(request.params.threadId.endsWith('999999999999')) { console.log(JSON.stringify({id:request.id,error:{code:-32600,message:'Chat not found.'}}));return; }
      let history={};try{history=JSON.parse(await readFile(join(root,'fake-history.json'),'utf8'));}catch{}
      if(history.fail) { console.log(JSON.stringify({id:request.id,error:{code:-32600,message:'History unavailable'}}));return; }
      if(process.env.CHILL_TEST_READ_DELAY)await delay(Number(process.env.CHILL_TEST_READ_DELAY));
      result={thread:{id:request.params.threadId,ephemeral:false,model:history.model||'gpt-6-astra',reasoningEffort:history.reasoningEffort||'medium',status:history.status||{type:'notLoaded'},turns:[]}};
    } else if(request.method==='thread/turns/list' || request.method==='thread/items/list') {
      let history={};try{history=JSON.parse(await readFile(join(root,'fake-history.json'),'utf8'));}catch{}
      if(history.fail) { console.log(JSON.stringify({id:request.id,error:{code:-32600,message:'History unavailable'}}));return; }
      const data=request.method==='thread/turns/list' ? history.turns || [] : history.items?.[request.params.turnId] || [];
      result={data,nextCursor:null};
    } else if(request.method==='model/list') result={data:[{id:'gpt-6-astra',displayName:'GPT-6 Astra'}]};
    else if(request.method==='account/rateLimits/read') {
      let history={};try{history=JSON.parse(await readFile(join(root,'fake-history.json'),'utf8'));}catch{}
      if(history.usageFail){console.log(JSON.stringify({id:request.id,error:{code:-32600,message:'Usage unavailable'}}));return;}
      result={rateLimitsByLimitId:{codex:{limitName:'Codex',primary:{usedPercent:12,windowDurationMins:10080,resetsAt:1791595319},secondary:null}},accountId:'private-account',credits:{balance:'62500'}};
    } else if(request.method==='thread/queue/list') result={data:queue.filter(entry=>entry.threadId===request.params.threadId),nextCursor:null};
    else if(request.method==='thread/queue/add') {
      if(process.env.CHILL_TEST_QUEUE_DELAY) await delay(Number(process.env.CHILL_TEST_QUEUE_DELAY));
      const entry={id:`queue-${queue.length+1}`,input:request.params.input,clientUserMessageId:request.params.clientUserMessageId,threadId:request.params.threadId};
      queue.push(entry);await writeFile(path,JSON.stringify(queue));
      if(process.env.CHILL_TEST_DROP_AFTER_ADD==='1')process.exit(0);
      result={queuedSubmission:entry};
    } else if(request.method==='thread/queue/delete') {
      if(process.env.CHILL_TEST_START_ON_DELETE==='1') {
        const entry=queue.find(e=>e.id===request.params.queuedSubmissionId);
        if(entry){
          const id='00000000-0000-0000-0000-000000000003',item={type:'userMessage',content:entry.input};
          queue=queue.filter(e=>e!==entry);await writeFile(path,JSON.stringify(queue));
          await writeFile(join(root,'fake-history.json'),JSON.stringify({turns:[{id,completedAt:null,status:'inProgress',items:[item]}],items:{[id]:[{turnId:id,item}]}}));
          console.log(JSON.stringify({id:request.id,result:{deleted:false}}));return;
        }
      }
      if(process.env.CHILL_TEST_DELETE_FAIL==='1') { console.log(JSON.stringify({id:request.id,error:{code:-32600,message:'Queue removal unavailable'}}));return; }
      const before=queue.length;
      queue=queue.filter(entry=>entry.threadId!==request.params.threadId||entry.id!==request.params.queuedSubmissionId);
      await writeFile(path,JSON.stringify(queue));
      if(process.env.CHILL_TEST_DROP_AFTER_DELETE==='1')process.exit(0);
      result={deleted:queue.length<before};
    } else { console.log(JSON.stringify({id:request.id,error:{code:-32601,message:'Unsupported method'}}));return; }
    console.log(JSON.stringify({id:request.id,result}));
  });
});
