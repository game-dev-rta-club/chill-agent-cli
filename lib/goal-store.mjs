import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { dataDirectory } from './data-directory.mjs';
import { recordServerUse } from './server-lifecycle.mjs';
import { writeJsonAtomically, readJson, numberedFiles, withStoreLock } from './storage.mjs';
import { letterState } from '../public/letter-state.js';
import { ownGoalProgress, progressPercent } from '../public/goal-progress.js';
import { markdownText } from './markdown.mjs';
import {briefText, briefSVG, validBriefFormat} from './brief.mjs';
import {sqliteSelected,withDatabase,decode,saveRecord,withSqliteTransaction} from './workspace-records.mjs';
import { goalState } from '../public/goal-state.js';
export { dataDirectory } from './data-directory.mjs';
export { writeJsonAtomically } from './storage.mjs';

export const workspaceDirectory=()=>join(dataDirectory(),'workspace');
const goalPath=id=>join(workspaceDirectory(),'goals',validId(id),'goal.json');
const briefDirectory=id=>join(workspaceDirectory(),'goals',validId(id),'briefs');
export const briefPath=(id,format='markdown')=>join(workspaceDirectory(),'goals',validId(id),validBriefFormat(format)==='html'?'brief.html':'brief.md');
const eventDirectory=()=>join(workspaceDirectory(),'events');
const touch=()=>recordServerUse(dataDirectory());
export function validId(id) {
  if(typeof id!=='string'||! /^[1-9][0-9]*$/.test(id)||!Number.isSafeInteger(Number(id))) throw new Error('Goal ID must be a positive integer.');
  return id;
}
export function validThreadId(id) {
  if(typeof id!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error('A valid thread UUID is required.');
  return id;
}
function text(value,name,max=10000,required=false) {
  if(typeof value!=='string'||value.length>max||(required&&!value.trim())) throw new Error(`${name} must be ${required?'nonempty ':''}text up to ${max} characters.`);
  return value.trim();
}
const usingSqlite=()=>sqliteSelected(workspaceDirectory());
const database=run=>withDatabase(workspaceDirectory(),run);
const operation=(name,run)=>usingSqlite()?withSqliteTransaction(workspaceDirectory(),run):withStoreLock(join(workspaceDirectory(),'locks',name),run);
async function writeGoal(goal,exclusive=false) {
  if(usingSqlite())return saveRecord(workspaceDirectory(),'goal',goal,exclusive);
  return writeJsonAtomically(goalPath(goal.id),goal,exclusive);
}
async function writeEvent(event,exclusive=false) {
  if(usingSqlite())return saveRecord(workspaceDirectory(),'event',event,exclusive);
  return writeJsonAtomically(join(eventDirectory(),`${event.id}.json`),event,exclusive);
}
export async function initializeStore() {
  if(usingSqlite()){await database(()=>{});return;}
  const path=join(workspaceDirectory(),'schema.json');
  let schema=await readJson(path);
  if(!schema) {
    try { await writeJsonAtomically(path,{format:'goal-workspace',version:7},true); }
    catch(error) { if(error.code!=='EEXIST') throw error; }
    schema=await readJson(path);
  }
  if(schema.format!=='goal-workspace'||schema.version!==7) throw new Error('Unsupported workspace. Use a current Goal workspace; legacy formats are not loaded.');
}
export async function readGoal(id) { await initializeStore(); validId(id); return usingSqlite()?database(db=>decode(db.prepare('SELECT body FROM goals WHERE id=?').get(Number(id)))):readJson(goalPath(id)); }
export async function readGoalContext(id) {
  const path=[];
  let current=await readGoal(id);
  if(!current) throw new Error('Goal not found.');
  while(current) {
    if(path.some(g=>g.id===current.id)) throw new Error('Goal hierarchy contains a cycle.');
    path.unshift(current);
    current=current.parentId?await readGoal(current.parentId):null;
  }
  return {goal:path.at(-1),root:path[0],path};
}
export async function listGoals() {
  await initializeStore();
  if(usingSqlite())return database(db=>db.prepare('SELECT body FROM goals ORDER BY id').all().map(decode));
  const ids=await numberedFiles(join(workspaceDirectory(),'goals'),/^([1-9][0-9]*)$/);
  return (await Promise.all(ids.map(id=>readGoal(String(id))))).filter(Boolean);
}
function validateGoal(input) {
  const title=text(input.title,'Goal title',300,true);
  const scope=text(input.scope??'','Scope');
  const criteria=text(input.criteria??'','Success criteria');
  const parentId=input.parentId??null;
  if(parentId!==null) validId(parentId);
  const state=input.state??'idle';
  if(!['idle','waiting','done'].includes(state)) throw new Error('State must be idle, waiting, or done. Live Working tracking is separate.');
  if(input.started!==undefined&&typeof input.started!=='boolean') throw new Error('started must be boolean.');
  const waitReason=state==='waiting'?text(input.waitReason??'','Waiting reason',2000,true):'';
  const threadId=input.threadId??null;
  if(threadId!==null) validThreadId(threadId);
  if(parentId&&threadId) throw new Error('Assign a chat to the root Goal only.');
  return {title,scope,criteria,parentId,state,started:state==='done'||Boolean(input.started),waitReason,threadId};
}
async function validateParent(id,parentId) {
  const seen=new Set([id]);
  while(parentId) {
    if(seen.has(parentId)) throw new Error('A Goal cannot be its own ancestor.');
    seen.add(parentId);
    const parent=await readGoal(parentId);
    if(!parent) throw new Error('Parent Goal not found.');
    parentId=parent.parentId;
  }
}
async function reopenAncestors(parentId,now) {
  while(parentId) {
    const parent=await readGoal(parentId);
    if(parent.state==='done')await writeGoal({...parent,state:'idle',waitReason:'',updatedAt:now});
    parentId=parent.parentId;
  }
}
function unfinishedDescendants(goals,id) {
  return goals.filter(g=>g.parentId===id).flatMap(g=>[
    ...(g.state==='done'?[]:[g]),...unfinishedDescendants(goals,g.id),
  ]);
}
export async function createGoal(input) {
  return createStoredGoal(input);
}
// Only the verified native hook calls this entry. Web/CLI create payloads cannot
// choose a connection, and there is deliberately no reassignment counterpart.
export async function createClaudeRoot(input,connection,requestId) {
  if(connection?.harnessId!=='claude-code'||typeof connection.sessionId!=='string'||!connection.sessionId.trim()||connection.sessionId.length>512||/[\x00-\x1f\x7f]/.test(connection.sessionId))throw Error('Invalid Claude connection.');
  validThreadId(connection.contextId);validThreadId(requestId);
  if(input.parentId||input.threadId)throw Error('Create a new Claude root, without a parent or Codex chat.');
  return createStoredGoal(input,{harnessId:'claude-code',sessionId:connection.sessionId,contextId:connection.contextId},requestId);
}
async function createStoredGoal(input,connection,creationRequestId) {
  await initializeStore();
  return operation('tree',async()=>{
    const value=validateGoal(input);
    const goals=await listGoals();
    const creationHash=connection?createHash('sha256').update(JSON.stringify({value,connection})).digest('hex'):null;
    const existing=creationRequestId&&goals.find(g=>g.creationRequestId===creationRequestId);
    if(existing){
      await mkdir(join(workspaceDirectory(),'goals',existing.id),{recursive:true});
      if(existing.creationHash!==creationHash)throw Error('Root creation request changed.');
      // Recover an interrupted initial Brief write without overwriting edits.
      await writeFile(briefPath(existing.id),'',{flag:'wx',mode:0o600}).catch(e=>{if(e.code!=='EEXIST')throw e;});
      return {...existing,briefPath:briefPath(existing.id)};
    }
    await validateParent(null,value.parentId);
    const id=String(Math.max(0,...goals.map(g=>Number(g.id)))+1);
    const now=new Date().toISOString();
    const goal={id,...value,...(connection?{connection,creationRequestId,creationHash}:{}),createdAt:now,updatedAt:now};
    // Reopen first, so a failed/interrupted write cannot leave a Done ancestor
    // above a newly unfinished child.
    await reopenAncestors(goal.parentId,now);
    await writeGoal(goal,true);
    await mkdir(join(workspaceDirectory(),'goals',id),{recursive:true});
    // A rolled-back database write can leave an unpublished source file.
    // Reuse it without overwriting the user's edits on the next attempt.
    await writeFile(briefPath(id),'',{flag:'wx',mode:0o600}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    await touch(); return {...goal,briefPath:briefPath(id)};
  });
}
export async function updateGoal(id,patch) {
  const allowed=['title','scope','criteria','parentId','state','started','waitReason','threadId'];
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(k=>!allowed.includes(k))) throw new Error('Unknown Goal field.');
  await initializeStore();
  return operation('tree',async()=>{
    const old=await readGoal(id); if(!old) throw new Error('Goal not found.');
    const value=validateGoal({...old,...patch});
    if(old.connection&&(value.threadId||value.parentId))throw Error('A native conversation cannot be reassigned or moved under another Root.');
    if(value.parentId!==old.parentId){
      const before=(await readGoalContext(id)).root;
      const after=value.parentId?(await readGoalContext(value.parentId)).root:null;
      if((before.connection||after?.connection)&&before.id!==after?.id)throw Error('Cannot move Goals between native conversations.');
    }
    await validateParent(id,value.parentId);
    if(value.state==='done') {
      const unfinished=unfinishedDescendants(await listGoals(),id);
      if(unfinished.length)throw new Error(`Cannot mark Goal #${id} Done: unfinished SubGoals ${unfinished.slice(0,10).map(g=>`#${g.id} ${JSON.stringify(g.title)}`).join(', ')}${unfinished.length>10?` and ${unfinished.length-10} more`:''}. Verify and complete their agreed criteria first.`);
    }
    const goal={...old,...value,updatedAt:new Date().toISOString()};
    if(goal.parentId!==old.parentId||(old.state==='done'&&goal.state!=='done'))await reopenAncestors(goal.parentId,goal.updatedAt);
    await writeGoal(goal);
    await touch(); return goal;
  });
}
export async function listVersions(id) { validId(id); if(usingSqlite())return database(db=>db.prepare('SELECT version FROM briefs WHERE goal_id=? ORDER BY version').all(Number(id)).map(row=>row.version)); return numberedFiles(briefDirectory(id),/^v([1-9][0-9]*)\.json$/); }
export async function readBrief(id,version) {
  validId(id);
  if(usingSqlite()) {
    if(version!==undefined&&(!Number.isSafeInteger(version)||version<1))throw Error('Brief version must be a positive integer.');
    return database(db=>decode(version===undefined?db.prepare('SELECT body FROM briefs WHERE goal_id=? ORDER BY version DESC LIMIT 1').get(Number(id)):db.prepare('SELECT body FROM briefs WHERE goal_id=? AND version=?').get(Number(id),version)));
  }
  const v=version??(await listVersions(id)).at(-1);
  if(v===undefined) return null;
  if(!Number.isSafeInteger(v)||v<1) throw new Error('Brief version must be a positive integer.');
  return readJson(join(briefDirectory(id),`v${v}.json`));
}
export async function briefSource(id,format) {
  if(!await readGoal(id))throw new Error('Goal not found.');
  const latest=await readBrief(id);
  format=validBriefFormat(format??latest?.format??'markdown');
  const path=briefPath(id,format);
  try {await writeFile(path,'',{flag:'wx',mode:0o600});} catch(error) {if(error.code!=='EEXIST')throw error;}
  return {goalId:id,format,path,latestVersion:latest?.version||0};
}
export async function updateBrief(id,format) {
  if(!await readGoal(id))throw new Error('Goal not found.');
  return operation(`brief-${id}`,async()=>{
    const previous=await readBrief(id);
    format=validBriefFormat(format??previous?.format??'markdown');
    const path=briefPath(id,format),body=await readFile(path,'utf8');
    text(body,'Brief',1000000);
    if(previous?.body===body&&previous.format===format)return {...previous,changed:false,path};
    const version=(previous?.version||0)+1;
    const brief={goalId:id,version,format,body,createdAt:new Date().toISOString()};
    if(usingSqlite())await saveRecord(workspaceDirectory(),'brief',brief,true);
    else await writeJsonAtomically(join(briefDirectory(id),`v${version}.json`),brief,true);
    await touch();return {...brief,changed:true,path};
  });
}
export async function readEvent(id) {
  if(!Number.isSafeInteger(id)||id<1)throw Error('A valid event ID is required.');
  return usingSqlite()?database(db=>decode(db.prepare('SELECT body FROM events WHERE id=?').get(id))):readJson(join(eventDirectory(),`${id}.json`));
}
export async function readFeedback(goalId) {
  if(goalId!==undefined)validId(goalId);
  if(usingSqlite())return database(db=>(goalId===undefined?db.prepare('SELECT body FROM events ORDER BY id').all():db.prepare('SELECT body FROM events WHERE goal_id=? ORDER BY id').all(Number(goalId))).map(decode));
  const events=await Promise.all((await numberedFiles(eventDirectory(),/^([1-9][0-9]*)\.json$/)).map(id=>readJson(join(eventDirectory(),`${id}.json`))));
  return goalId===undefined?events:events.filter(event=>event.goalId===goalId);
}
const eventCursor=events=>events.reduce((cursor,event)=>Math.max(cursor,event.changeId),0);
const nextChangeId=async events=>usingSqlite()?database(db=>db.prepare('SELECT coalesce(max(change_id),0)+1 AS id FROM events').get().id):eventCursor(events)+1;
export async function listEventsSince(since=0) {
  if(!Number.isSafeInteger(since)||since<0) throw new Error('Cursor must be a non-negative integer.');
  if(usingSqlite())return database(db=>({cursor:db.prepare('SELECT coalesce(max(change_id),0) AS cursor FROM events').get().cursor,events:db.prepare('SELECT body FROM events WHERE change_id>? ORDER BY change_id').all(since).map(decode)}));
  const events=await readFeedback(); return {cursor:eventCursor(events),events:events.filter(e=>e.changeId>since).sort((a,b)=>a.changeId-b.changeId)};
}
// A page cursor uses changeId, not event ID: closing a Letter updates the
// existing event. Consumers reconcile later changes by ID through /api/events.
export async function readConversationPage(goalId,{before,limit=30}={}) {
  validId(goalId);
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('limit must be an integer from 1 to 100.');
  if(before!==undefined&&(!Number.isSafeInteger(before)||before<1))throw Error('before must be a positive integer.');
  const result=(selected,cursor,lookup)=>{
    const hasMore=selected.length>limit;
    const events=selected.slice(0,limit).reverse();
    const ids=[...new Set(events.flatMap(event=>(event.annotations||[]).filter(note=>note.kind==='letter').map(note=>note.source?.eventId)).filter(Number.isSafeInteger))];
    return {goalId,events,answerTargets:ids.map(lookup).filter(event=>event?.goalId===goalId&&event.type==='letter'&&event.author==='agent'),cursor,hasMore,nextBefore:hasMore?events[0].changeId:null};
  };
  if(usingSqlite())return database(db=>{
    // A consistent read snapshot keeps the watermark, page and reply targets
    // together without taking a writer lock.
    db.exec('BEGIN');
    try {
      if(!db.prepare('SELECT id FROM goals WHERE id=?').get(Number(goalId)))throw Object.assign(Error('Goal not found.'),{status:404});
      const cursor=db.prepare('SELECT coalesce(max(change_id),0) AS cursor FROM events').get().cursor;
      const rows=before===undefined
        ?db.prepare('SELECT body FROM events WHERE goal_id=? ORDER BY change_id DESC LIMIT ?').all(Number(goalId),limit+1)
        :db.prepare('SELECT body FROM events WHERE goal_id=? AND change_id<? ORDER BY change_id DESC LIMIT ?').all(Number(goalId),before,limit+1);
      const page=result(rows.map(decode),cursor,id=>decode(db.prepare('SELECT body FROM events WHERE id=? AND goal_id=?').get(id,Number(goalId))));
      db.exec('COMMIT');return page;
    }catch(error){db.exec('ROLLBACK');throw error;}
  });
  if(!await readGoal(goalId))throw Object.assign(Error('Goal not found.'),{status:404});
  const all=await readFeedback();
  return result(all.filter(event=>event.goalId===goalId&&(before===undefined||event.changeId<before)).sort((a,b)=>b.changeId-a.changeId),eventCursor(all),id=>all.find(event=>event.id===id));
}
export async function checkFeedback({since=0,goalId}={}) {
  if(goalId!==undefined) validId(goalId);
  const {cursor,events}=await listEventsSince(since);
  const changed=events.filter(e=>e.author==='user'&&(!goalId||e.goalId===goalId));
  return {cursor,count:changed.length,lastUpdatedAt:changed.at(-1)?.updatedAt||null};
}
export const feedbackImageIds=item=>item?.attachmentIds||[];
async function validateFeedbackImages(item) {
  if(item.attachmentIds!==undefined&&(!Array.isArray(item.attachmentIds)||item.attachmentIds.length>30||new Set(item.attachmentIds).size!==item.attachmentIds.length)) throw new Error('Use at most 30 distinct images in attachmentIds.');
  for(const id of feedbackImageIds(item)) if(!await attachmentInfo(id)) throw new Error('Image not found.');
}
export async function appendFeedback(input) { return appendEvent({...input,type:'comment',author:'user'}); }
export async function appendAgentComment(input) { return appendEvent({...input,author:'agent'}); }
export async function closeLetter(goalId,id,reason='') {
  if(!Number.isSafeInteger(id)||id<1)throw new Error('Letter event ID must be a positive integer.');
  text(reason,'Receipt reason',2000);
  await readGoalContext(goalId);
  return operation('events',async()=>{
    const events=await readFeedback(usingSqlite()?goalId:undefined),letter=events.find(e=>e.id===id&&e.goalId===goalId&&e.type==='letter'&&e.author==='agent');
    if(!letter)throw new Error('Letter not found in this Goal.');
    const state=letterState(letter,events);
    if(state.status!=='open')return {...letter,status:state.status,changed:false};
    const received={...letter,changeId:await nextChangeId(events),receivedAt:new Date().toISOString(),...(reason.trim()?{receiveReason:reason.trim()}:{})};
    await writeEvent(received);
    await touch();return {...received,status:'received',changed:true};
  });
}
async function appendEvent(input) {
  const allowed=['goalId','type','title','text','attachmentIds','annotations','requestId','author','replyRequired'];
  if(Object.keys(input).some(key=>!allowed.includes(key))) throw new Error('Unknown Conversation field.');
  const {goalId,type,title,text:message='',attachmentIds=[],annotations=[],requestId,author,replyRequired}=input;
  const {root}=await readGoalContext(goalId);
  if(!['comment','letter'].includes(type))throw new Error('Choose Comment to share an update, or Letter to ask for a user reply.');
  if(replyRequired!==undefined&&(type!=='letter'||typeof replyRequired!=='boolean'))throw new Error('replyRequired is a boolean for Letters only.');
  if(type==='letter'&&author!=='agent')throw new Error('Only an Agent can send a Letter.');
  if(type==='letter') {text(title,'Letter title',300,true);text(message,'Letter',10000,true);}
  else if(title!==undefined)throw new Error('Titles belong to Letters.');
  text(message,'Comment',10000);
  if(!Array.isArray(annotations)||annotations.length>30) throw new Error('Use at most 30 annotations.');
  const replies=annotations.filter(n=>n?.kind==='letter');
  if(new Set(replies.map(n=>n.source?.eventId)).size!==replies.length)throw new Error('Answer each Letter once per comment.');
  await validateFeedbackImages({attachmentIds});
  if(!message.trim()&&!attachmentIds.length&&!annotations.length) throw new Error('Comment must contain text, an image, or an annotation.');
  if(requestId!==undefined&&(typeof requestId!=='string'||! /^[a-zA-Z0-9-]{8,80}$/.test(requestId))) throw new Error('Invalid request ID.');
  const requestHash=createHash('sha256').update(JSON.stringify({type,title,message,attachmentIds,annotations,...(replyRequired===false?{replyRequired:false}:{})})).digest('hex');
  return operation('events',async()=>{
    const events=await readFeedback(usingSqlite()?goalId:undefined),conversation=events.filter(e=>e.goalId===goalId);
    if(requestId) {
      const previous=events.find(e=>e.requestId===requestId&&e.goalId===goalId&&e.author===author);
      if(previous) { if(previous.requestHash!==requestHash) throw new Error('This request already saved different feedback.'); return previous; }
    }
    for(const annotation of annotations) {
      if(!annotation||typeof annotation!=='object') throw new Error('Invalid annotation.');
      text(annotation.text,'Annotation',2000); await validateFeedbackImages(annotation);
      if(!annotation.text.trim()&&!feedbackImageIds(annotation).length) throw new Error('Add text or an image to the annotation.');
      if(annotation.kind==='letter') {
        if(author!=='user'||annotation.source?.kind!=='comment'||!Number.isSafeInteger(annotation.source.eventId))throw new Error('A Letter answer must refer to an Agent Letter.');
        if(!conversation.some(e=>e.id===annotation.source.eventId&&e.type==='letter'&&e.author==='agent'))throw new Error('Letter not found in this Goal.');
      } else if(annotation.kind==='text') {
        const a=annotation.anchor;
        if(!a||!Number.isSafeInteger(a.start)||!Number.isSafeInteger(a.end)||a.start<0||a.end<=a.start||a.end-a.start>2000||typeof a.quote!=='string'||!a.quote.trim()||a.quote.length>2000) throw new Error('Invalid text annotation.');
        if(annotation.source?.kind==='comment') {
          const comment=conversation.find(e=>e.id===annotation.source.eventId&&e.author==='agent');
          const field=annotation.source.field;
          if(field!==undefined&&field!=='title')throw new Error('Annotation field must be title or omitted for the message text.');
          const sourceText=field==='title'?(comment?.type==='letter'?comment.title:undefined):comment?markdownText(comment.text):undefined;
          if(typeof sourceText!=='string'||a.end>sourceText.length||sourceText.slice(a.start,a.end).trim()!==a.quote.trim()) throw new Error('Annotation must quote an Agent comment or Letter title in this Goal.');
        } else if(annotation.source?.kind==='brief') {
          const brief=Number.isSafeInteger(annotation.source.version)?await readBrief(goalId,annotation.source.version):null;
          const sourceText=brief?briefText(brief.body,brief.format):null;
          if(sourceText===null||a.end>sourceText.length||sourceText.slice(a.start,a.end).trim()!==a.quote.trim())throw new Error('Annotation must quote an existing Brief version.');
        } else throw new Error('Invalid annotation source.');
      } else if(annotation.kind==='image') {
        const r=annotation.rect;
        let belongs=false;
        if(annotation.source!==undefined){
          const s=annotation.source;
          const brief=s?.kind==='brief'&&Number.isSafeInteger(s.version)?await readBrief(goalId,s.version):null;
          belongs=!annotation.imageId&&brief?.format==='html'&&Boolean(briefSVG(brief.body,s.svgIndex));
        }else{
          const briefs=await Promise.all((await listVersions(goalId)).map(v=>readBrief(goalId,v)));
          belongs=(briefs.some(o=>o.body.includes(`/api/images/${annotation.imageId}`))||conversation.some(e=>feedbackImageIds(e).includes(annotation.imageId))||attachmentIds.includes(annotation.imageId))&&Boolean(await attachmentInfo(annotation.imageId));
        }
        if(!belongs||!r||![r.x,r.y,r.width,r.height].every(n=>typeof n==='number'&&Number.isFinite(n))||r.x<0||r.y<0||r.width<=0||r.height<=0||r.x+r.width>1.00001||r.y+r.height>1.00001) throw new Error('Invalid image annotation for this Goal.');
        if(annotation.imageName!==undefined) text(annotation.imageName,'Image name',200,true);
      } else throw new Error('Unknown annotation type.');
    }
    const changeId=await nextChangeId(events);
    const event={id:changeId,changeId,goalId,author,type,text:message.trim(),updatedAt:new Date().toISOString(),
      ...(type==='letter'?{title:title.trim(),...(replyRequired===false?{replyRequired:false}:{})}:{}),
      ...(author==='user'&&root.threadId?{threadId:root.threadId}:{}),
      ...(author==='user'&&root.connection?{connection:root.connection}:{}),
      ...(requestId?{requestId,requestHash}:{}),...(attachmentIds.length?{attachmentIds}:{}),
      ...(annotations.length?{annotations:annotations.map(n=>({id:randomUUID(),kind:n.kind,text:n.text.trim(),
        ...(feedbackImageIds(n).length?{attachmentIds:n.attachmentIds}:{}),
        ...(n.kind==='letter'?{source:n.source}:n.kind==='text'?{anchor:n.anchor,source:n.source}:{...(n.source?{source:{kind:'brief',version:n.source.version,svgIndex:n.source.svgIndex}}:{imageId:n.imageId}),rect:n.rect,...(n.imageName?{imageName:n.imageName}:{})})}))}:{})};
    await writeEvent(event,true);await touch();return event;
  });
}
export async function listStoredGoals() {
  const feedback=await readFeedback();
  return Promise.all((await listGoals()).map(async goal=>({...goal,
    briefPath:briefPath(goal.id,(await readBrief(goal.id))?.format),
    briefs:await Promise.all((await listVersions(goal.id)).map(v=>readBrief(goal.id,v))),
    conversation:feedback.filter(e=>e.goalId===goal.id).sort((a,b)=>Date.parse(a.updatedAt)-Date.parse(b.updatedAt)||a.id-b.id)})));
}
export async function readWorkspaceTree(rootId) {
  return workspaceTree(await listStoredGoals(),rootId);
}
export async function readOpenLetters(id) {
  const [root]=await readWorkspaceTree(id);
  const collect=node=>[...node.letters,...node.children.flatMap(collect)];
  return collect(root);
}
export function workspaceTree(goals,rootId) {
  if(rootId!==undefined&&!goals.some(g=>g.id===validId(rootId))) throw new Error('Goal not found.');
  function branch(goal) {
    const children=goals.filter(g=>g.parentId===goal.id).map(branch);
    const ownLetters=goal.conversation.filter(e=>letterState(e,goal.conversation)?.status==='open')
      .map(({id,title})=>({goalId:goal.id,id,title}));
    const goalScores=children.length?children.flatMap(c=>c.goalScores):[ownGoalProgress(goal)];
    const state=goalState(goal,children.map(c=>c.state));
    return {id:goal.id,title:goal.title,parentId:goal.parentId,scope:goal.scope,criteria:goal.criteria,state,waitReason:goal.waitReason,
      ...(goal.execution?{execution:goal.execution}:{}),
      progress:progressPercent(goalScores,goal),goalScores,
      latestVersion:goal.briefs.at(-1)?.version||0,letters:ownLetters,letterCount:ownLetters.length+children.reduce((sum,c)=>sum+c.letterCount,0),children};
  }
  const tree=goals.filter(g=>rootId?g.id===rootId:!g.parentId).map(branch);
  function compact(g) { const {goalScores,children,...node}=g; return {...node,children:children.map(compact)}; }
  return tree.map(compact);
}
const imageTypes = new Map([
  ['image/png', { extension: 'png', matches: data => data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) }],
  ['image/jpeg', { extension: 'jpg', matches: data => data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff }],
  ['image/webp', { extension: 'webp', matches: data => data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' }],
]);

export async function saveAttachment(data, mimeType) {
  const type = imageTypes.get(mimeType);
  if (!type || !Buffer.isBuffer(data) || !data.length || data.length > 5 * 1024 * 1024 || !type.matches(data)) {
    throw new Error('Use a PNG, JPEG, or WebP image up to 5 MB.');
  }
  const id = randomUUID();
  const directory = join(workspaceDirectory(), 'attachments');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${id}.${type.extension}`), data, { flag: 'wx', mode: 0o600 });
  await recordServerUse(dataDirectory());
  return { id, mimeType };
}

export async function attachmentInfo(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return null;
  for (const [mimeType, type] of imageTypes) {
    const path = join(workspaceDirectory(), 'attachments', `${id}.${type.extension}`);
    try {
      await readFile(path);
      return { id, path, mimeType };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return null;
}
