import {withCodex} from './codex-client.mjs';
import {canUpdateDesktopSettings,updateDesktopSettings,canControlDesktop} from './desktop-settings.mjs';
import {join} from 'node:path';
import {workspaceDirectory,validThreadId} from './goal-store.mjs';
import {readJson} from './storage.mjs';
import {hidden,recordHidden} from './hidden-failure.mjs';

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
  readHeartbeat=readCodexHeartbeat,
}={}) {
  return {
    harnessId:'codex-desktop',sessionId,messageLabel:'Codex message',
    async readRunSnapshot() {
      // One native connection keeps thread, turn and queue observations together.
      const [heartbeat,native]=await Promise.all([readHeartbeat(sessionId),run(async client=>{
        // All three settle before the connection closes, so a failed thread read never
        // cuts the queue read short and records it as a failure of its own.
        const [read,listed,queued]=await Promise.allSettled([
          client.request('thread/read',{threadId:sessionId,includeTurns:false}),
          client.request('thread/turns/list',{threadId:sessionId,limit:1,itemsView:'notLoaded'}),
          client.request('thread/queue/list',{threadId:sessionId,limit:1}),
        ]);
        for(const result of [read,listed])if(result.status==='rejected')throw result.reason;
        const response=read.value,turns=listed.value,queue=queued.status==='fulfilled'?queued.value:hidden('codex-desktop-connection.queue')(queued.reason);
        if(response.thread?.id!==sessionId)throw Error('Agent assignment changed. Try again.');
        const latest=turns.data?.[0];
        return {threadState:response.thread.status?.type||'unknown',
          turn:latest?.id?{id:latest.id,status:latest.status,completedAt:latest.completedAt}:null,
          queue:queue?{data:(queue.data||[]).map(item=>({id:item.id}))}:null};
      })]);
      return {...native,heartbeat};
    },
    async readSnapshot() {
      return run(async client=>{
        const results=await Promise.allSettled([
          client.request('thread/read',{threadId:sessionId,includeTurns:false}),
          client.request('model/list',{limit:100}),
          client.request('account/rateLimits/read',{}),
          (async()=>{let cursor,data=[],pages=0;do{const page=await client.request('thread/queue/list',{threadId:sessionId,limit:100,...(cursor?{cursor}:{})});data.push(...page.data);cursor=page.nextCursor;if(++pages>=10)return {data,truncated:Boolean(cursor)};}while(cursor);return {data,truncated:false};})(),
        ]);
        results.forEach((r,i)=>{if(r.status==='rejected')recordHidden(`codex-desktop-connection.snapshot-${['thread','models','usage','queue'][i]}`,r.reason);});
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
