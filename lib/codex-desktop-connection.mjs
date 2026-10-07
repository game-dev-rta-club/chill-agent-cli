import {withCodex} from './codex-client.mjs';
import {canUpdateDesktopSettings,updateDesktopSettings,canControlDesktop} from './desktop-settings.mjs';
import {join} from 'node:path';
import {workspaceDirectory,validThreadId} from './goal-store.mjs';
import {readJson} from './storage.mjs';
import {readControlRecord,controlView} from './agent-control.mjs';

export const readCodexHeartbeat=id=>readJson(join(workspaceDirectory(),'agent-heartbeats',`${validThreadId(id)}.json`));

export function usageWindows(result) {
  const buckets=result?.rateLimitsByLimitId;
  const entries=buckets&&Object.keys(buckets).length?Object.entries(buckets):result?.rateLimits?[[result.rateLimits.limitId||'codex',result.rateLimits]]:[];
  return entries.map(([id,bucket])=>({id,name:bucket.limitName||id,windows:['primary','secondary'].filter(key=>bucket[key]).map(key=>{
    const w=bucket[key];return {id:key,remaining:typeof w.usedPercent==='number'&&Number.isFinite(w.usedPercent)?Math.max(0,Math.min(100,100-w.usedPercent)):null,
      minutes:Number.isFinite(w.windowDurationMins)?w.windowDurationMins:null,resetAt:Number.isFinite(w.resetsAt)?w.resetsAt:null};
  })}));
}

// Only this adapter interprets Codex RPC fields and Desktop IPC results.
export function createCodexDesktopConnection(sessionId,{
  run=withCodex,canSave=canUpdateDesktopSettings,update=updateDesktopSettings,canControl=canControlDesktop,
  readControl=readControlRecord,readHeartbeat=readCodexHeartbeat,
}={}) {
  return {
    harnessId:'codex-desktop',sessionId,messageLabel:'Codex message',
    async readRunSnapshot() {
      // One native connection keeps thread, turn and queue observations together.
      // Only this adapter reads the legacy Codex control/heartbeat files.
      const [record,heartbeat,native]=await Promise.all([readControl(sessionId),readHeartbeat(sessionId),run(async client=>{
        const [response,turns,queue]=await Promise.all([
          client.request('thread/read',{threadId:sessionId,includeTurns:false}),
          client.request('thread/turns/list',{threadId:sessionId,limit:1,itemsView:'notLoaded'}),
          client.request('thread/queue/list',{threadId:sessionId,limit:1}).catch(()=>null),
        ]);
        if(response.thread?.id!==sessionId)throw Error('Agent assignment changed. Try again.');
        const latest=turns.data?.[0];
        return {threadState:response.thread.status?.type||'unknown',
          turn:latest?.id?{id:latest.id,status:latest.status,completedAt:latest.completedAt}:null,
          queue:queue?{data:(queue.data||[]).map(item=>({id:item.id}))}:null};
      })]);
      return {...native,record,heartbeat,view:controlView(record,native.turn)};
    },
    async readSnapshot() {
      return run(async client=>{
        const results=await Promise.allSettled([
          client.request('thread/read',{threadId:sessionId,includeTurns:false}),
          client.request('model/list',{limit:100}),
          client.request('account/rateLimits/read',{}),
          (async()=>{let cursor,data=[],pages=0;do{const page=await client.request('thread/queue/list',{threadId:sessionId,limit:100,...(cursor?{cursor}:{})});data.push(...page.data);cursor=page.nextCursor;if(++pages>=10)return {data,truncated:Boolean(cursor)};}while(cursor);return {data,truncated:false};})(),
        ]);
        const values=results.map(r=>r.status==='fulfilled'?r.value:null),thread=values[0]?.thread;
        if(thread&&thread.id!==sessionId)throw Error('Agent assignment changed. Try again.');
        const models=values[1]?.data||[],model=models.find(m=>m.id===thread?.model||m.model===thread?.model);
        return {
          settings:thread?{model:thread.model||null,label:model?.displayName||thread.model||null,reasoning:thread.reasoningEffort||null}:null,
          models:models.filter(m=>!m.hidden).map(m=>({id:m.model||m.id,label:m.displayName||m.model||m.id,efforts:(m.supportedReasoningEfforts||[]).map(e=>e.reasoningEffort),defaultEffort:m.defaultReasoningEffort})),
          usage:values[2]===null?null:usageWindows(values[2]),
          queue:values[3]?{truncated:values[3].truncated,items:values[3].data.map(item=>({messageId:item.clientUserMessageId}))}:null,
          checkedAt:new Date().toISOString(),
        };
      });
    },
    async canSaveSettings(data) {
      return Boolean(data.settings&&await canSave(sessionId,{model:data.settings.model,effort:data.settings.reasoning}));
    },
    async saveSettings(settings,expected) {return (await update(sessionId,settings,expected))?.applied===true;},
    canControl:()=>canControl(sessionId),
  };
}
