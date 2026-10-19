// What a Claude conversation is doing, kept in its connection record from its
// own main hooks as agent-rules events. The transcript is not parsed for this:
// only its last bytes are read for an Esc interrupt, which no hook reports.
import {randomUUID} from 'node:crypto';
import {open,stat} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {idleWork,nextWork} from './agent-rules.mjs';
import {dataDirectory} from './data-directory.mjs';
import {claudeEntryPaths,validEntry} from './claude-entry.mjs';
import {validTranscriptPath} from './claude-transcript.mjs';
import {readJson,withStoreLock,writeJsonAtomically} from './storage.mjs';
import {recordHidden} from './hidden-failure.mjs';

// The work kept in a record; `id` names one stretch of work, so `goal work`
// lasts exactly as long as the work that selected it.
export const recordedWork=record=>record?.agentWork??{...idleWork,id:null,startedAt:null};
// A prompt or a wake always begins new work (`fresh`), even when Esc ended the
// last one without a hook: Esc is only read from the transcript.
export function applyWork(work,events,now=new Date()) {
  let next=work;
  for(const event of events){
    const before=next;
    next=nextWork(next,event);
    if(next.phase==='working'&&(before.phase!=='working'||event.fresh))next={...next,id:randomUUID(),startedAt:now.toISOString()};
  }
  return next;
}

// Claude Code lists the tasks still running when a response stops. Background
// agents run on and report back; shells are left out, since a dev server and
// a build look the same. chill's own reply waiter is a shell, too. Each task
// keeps Claude's own fields: its type and the name of what runs it.
const taskName=task=>task.agent_type||task.name||(task.server&&task.tool?`${task.server} ${task.tool}`:null);
export const backgroundTasks=tasks=>(Array.isArray(tasks)?tasks:[]).filter(task=>task&&task.type!=='shell'&&task.status!=='completed')
  .map(task=>({id:String(task.id),type:String(task.type),name:taskName(task)??null,description:typeof task.description==='string'?task.description.slice(0,200):null}));

// When each background subagent last wrote its own transcript, which Claude
// keeps beside the conversation's. Other task types leave no file to read.
export async function backgroundActivity(record,tasks) {
  if(!Array.isArray(tasks))return [];
  const folder=validTranscriptPath(record?.transcriptPath)&&/^[\w-]+$/.test(record.sessionId)?join(dirname(record.transcriptPath),record.sessionId,'subagents'):null;
  return Promise.all(tasks.map(async task=>{
    const file=folder&&task.type==='subagent'&&/^[\w-]+$/.test(task.id)?join(folder,`agent-${task.id}.jsonl`):null;
    const written=file?await stat(file).then(s=>s.mtime.toISOString(),()=>null):null;
    return {...task,activeAt:written};
  }));
}

// The event a main hook reports by its arrival. Stop is decided where its
// outcome is known (handleClaudeStop); subagent hooks report nothing.
export function hookWorkEvent(input) {
  if(!input||input.agent_id!=null)return null;
  if(input.hook_event_name==='UserPromptSubmit')return {type:'started',fresh:true};
  if(['PreToolUse','PermissionRequest','PostToolUse'].includes(input.hook_event_name))return {type:'started'};
  if(input.hook_event_name==='StopFailure')return {type:'interrupted'};
  if(input.hook_event_name==='SessionEnd')return {type:'ended'};
  return null;
}

// What bin/chill-connection does first with every Claude hook.
export const reportClaudeHook=(input,options)=>{const event=hookWorkEvent(input);return event&&typeof input.session_id==='string'?recordClaudeWork(input.session_id,[event],options):null;};

// Record events for a conversation. A record that does not change is not
// written, so every tool hook costs one read while the work runs.
export async function recordClaudeWork(sessionId,events,{directory=dataDirectory(),now=()=>new Date()}={}) {
  if(!events.length)return null;
  const location=claudeEntryPaths(directory,sessionId);
  return withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record);
    if(!validEntry(record,sessionId))return null;
    const work=recordedWork(record),next=applyWork(work,events,now());
    if(JSON.stringify(next)!==JSON.stringify(work))await writeJsonAtomically(location.record,{...record,agentWork:next});
    return next;
  });
}

// Esc ends a response without any hook; Claude Code writes the interrupt into
// the transcript. Only the tail written since the work started is read.
const tailBytes=256*1024;
async function interruptedSince(path,since) {
  if(!validTranscriptPath(path)||!since)return false;
  let file;
  try {
    const {size}=await stat(path),length=Math.min(size,tailBytes);
    file=await open(path,'r');
    const buffer=Buffer.alloc(length);
    await file.read(buffer,0,length,size-length);
    for(const line of buffer.toString('utf8').split('\n').reverse()){
      if(!line.includes('[Request interrupted'))continue;
      let entry;try{entry=JSON.parse(line);}catch{continue;}
      if(entry.type==='user'&&!entry.isSidechain&&Date.parse(entry.timestamp)>=Date.parse(since))return true;
    }
    return false;
  } catch(error) {if(error.code!=='ENOENT')recordHidden('claude-agent-work.interrupt',error);return false;}
  finally {await file?.close();}
}

// A conversation whose Claude Code quit or crashed reports nothing more. Work
// that wrote nothing for this long is unknown, never silently idle or Running.
export const silentMs=30*60*1000;
// The conversation's work as shown now: its record, with an Esc interrupt
// applied and long silence marked unknown. Reading changes nothing.
export async function observedClaudeWork(record,{now=Date.now}={}) {
  const work=recordedWork(record);
  if(work.phase!=='working')return {work,known:true};
  if(await interruptedSince(record.transcriptPath,work.startedAt))return {work:nextWork(work,{type:'interrupted'}),known:true};
  const written=validTranscriptPath(record.transcriptPath)?await stat(record.transcriptPath).then(s=>s.mtimeMs,()=>null):null;
  const last=Math.max(written??0,Date.parse(work.startedAt)||0);
  return {work,known:now()-last<silentMs};
}
