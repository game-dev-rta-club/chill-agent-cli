import { link, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
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
import { validAutonomy } from '../public/autonomy.js';
import { withAutonomy, sameConnection } from './continuation-owner.mjs';
import {largeCount,largeSize} from './limits.mjs';
export { dataDirectory } from './data-directory.mjs';
export { writeJsonAtomically } from './storage.mjs';

export const workspaceDirectory=()=>join(dataDirectory(),'workspace');
const goalPath=id=>join(workspaceDirectory(),'goals',validId(id),'goal.json');
const briefDirectory=id=>join(workspaceDirectory(),'goals',validId(id),'briefs');
export const briefPath=(id,format='html')=>join(workspaceDirectory(),'goals',validId(id),validBriefFormat(format)==='html'?'deliverable.html':'deliverable.md');
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
function text(value,name,required=false) {
  if(typeof value!=='string'||value.length>largeSize||(required&&!value.trim())) throw new Error(`${name} must be ${required?'nonempty ':''}text.`);
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
// The editable Brief files were renamed to Deliverable. Move each one once,
// never over a file that already exists under the new name.
const renamedSources=new Set();
async function renameEditableSources() {
  const root=join(workspaceDirectory(),'goals');
  if(renamedSources.has(root))return;
  let ids=[];
  try{ids=await readdir(root);}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const id of ids)for(const ext of ['md','html']){
    const from=join(root,id,`brief.${ext}`),to=join(root,id,`deliverable.${ext}`);
    try{await link(from,to);await unlink(from);}
    catch(error){if(!['ENOENT','EEXIST','ENOTDIR'].includes(error.code))throw error;}
  }
  renamedSources.add(root);
}
export async function initializeStore() {
  // Offline migration data retains old bindings and receipt semantics. It must
  // not resume transport until activation explicitly reconciles those records.
  try { await readFile(join(dataDirectory(),'migration-pending.json')); throw Error('Migration is offline-prepared; reconcile activation before starting this workspace.'); }
  catch(error) { if(error.code!=='ENOENT')throw error; }
  await renameEditableSources();
  if(usingSqlite())await database(()=>{});
  else {
    const path=join(workspaceDirectory(),'schema.json');
    let schema=await readJson(path);
    if(!schema) {
      try { await writeJsonAtomically(path,{format:'goal-workspace',version:7},true); }
      catch(error) { if(error.code!=='EEXIST') throw error; }
      schema=await readJson(path);
    }
    if(schema.format!=='goal-workspace'||schema.version!==7) throw new Error('Unsupported workspace. Use a current Goal workspace; legacy formats are not loaded.');
  }
  await migrateAutonomy();
}
// AutoContinue was an On/Off switch kept in each Root's continuation journal.
// Once, every Goal under a Root that had it On is given the level now named
// Auto Continue (3 on the four-level scale of that time, renumbered below; the
// Root's level then moves into its journal); the switch is removed from the
// journal, so no old setting is left behind. Goals elsewhere read as Normal.
// The journal's attempts and revision stay.
const autonomyMigrations=new Map();
function migrateAutonomy() {
  const root=workspaceDirectory();
  if(!autonomyMigrations.has(root))autonomyMigrations.set(root,migrateAutonomyLevels().catch(error=>{autonomyMigrations.delete(root);throw error;}));
  return autonomyMigrations.get(root);
}
// The AutoContinue move runs first, so a workspace that had neither ends on
// the three-level scale. Once renumbered, a switch an older runtime wrote again
// moves its Goals to Auto Continue on that scale, 2. The move to Roots runs last.
async function migrateAutonomyLevels() {
  const renumbered=await autonomyRenumbered();
  await migrateAutoContinue(renumbered?2:3);
  if(!renumbered)await renumberAutonomy();
  await moveAutonomyToRoots();
}
async function migrateAutoContinue(continueLevel) {
  const directory=join(workspaceDirectory(),'continuation');
  for(const rootId of await numberedFiles(directory,/^([1-9][0-9]*)\.json$/)) {
    const path=join(directory,`${rootId}.json`);
    if(!Object.hasOwn(await readJson(path)??{},'enabled'))continue;
    await operation('tree',async()=>{
      const journal=await readJson(path);
      if(!Object.hasOwn(journal??{},'enabled'))return;
      if(journal.enabled===true) {
        const goals=await storedGoals(),byId=new Map(goals.map(g=>[g.id,g]));
        const rootOf=goal=>{const seen=new Set();while(goal?.parentId&&!seen.has(goal.id)){seen.add(goal.id);goal=byId.get(goal.parentId);}return goal?.id;};
        for(const goal of goals)if(rootOf(goal)===String(rootId)&&goal.autonomy===undefined)await writeGoal({...goal,autonomy:continueLevel});
      }
      const {enabled,paused,...rest}=journal;
      await writeJsonAtomically(path,rest);
    });
  }
}
// Autonomy had four levels, 1 Normal, 2 Thorough, 3 Continue and 4 Drive (now
// Normal, Auto Continue and Ultra Continue).
// Thorough was dropped, so once per workspace each stored level moves to the
// three-level scale: 2 becomes 1, 3 becomes 2 and 4 becomes 3. The Goals to
// move and their old levels are recorded before any is written, and the
// workspace is marked done after, so an interrupted run repeats the same
// writes instead of moving a Goal twice.
const autonomyScalePath=()=>join(workspaceDirectory(),'autonomy-scale.json');
const autonomyRenumbered=async()=>(await readJson(autonomyScalePath()))?.levels===3;
async function renumberAutonomy() {
  const path=autonomyScalePath();
  const done=await operation('tree',async()=>{
    let marker=await readJson(path);
    if(marker?.levels===3)return true;
    const goals=await storedGoals();
    if(!marker?.from) {
      marker={from:Object.fromEntries(goals.filter(goal=>[2,3,4].includes(goal.autonomy)).map(goal=>[goal.id,goal.autonomy]))};
      await writeJsonAtomically(path,marker);
    }
    for(const goal of goals)if(Object.hasOwn(marker.from,goal.id))await writeGoal({...goal,autonomy:marker.from[goal.id]-1});
    return false;
  });
  if(!done)await writeJsonAtomically(path,{levels:3});
}
// Autonomy was kept on each Goal and is now one value per Root's agent, in
// the Root's continuation journal (root-autonomy). Each Root Goal's level, when
// above Normal, is written into its journal for the Root's current agent, or
// for none yet; then the field is removed from every Goal. A run cut short
// writes the same journals again, and once the field is gone nothing is left
// to move. Goals an older runtime gives a level again move the same way.
async function moveAutonomyToRoots() {
  if(!(await storedGoals()).some(goal=>Object.hasOwn(goal,'autonomy')))return;
  await operation('tree',async()=>{
    const goals=await storedGoals(),directory=join(workspaceDirectory(),'continuation');
    for(const root of goals.filter(goal=>!goal.parentId&&validAutonomy(goal.autonomy)&&goal.autonomy>1)) {
      const path=join(directory,`${root.id}.json`),next=withAutonomy(root,await readJson(path),root.autonomy);
      if(next)await writeJsonAtomically(path,next);
    }
    for(const goal of goals)if(Object.hasOwn(goal,'autonomy')){const {autonomy,...rest}=goal;await writeGoal(rest);}
  });
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
// Archived roots retain IDs and history, but leave active lists and monitors.
export function visibleGoals(goals) {
  const hidden=new Set(goals.filter(goal=>goal.archived).map(goal=>goal.id));
  let changed=true;
  while(changed){changed=false;for(const goal of goals)if(hidden.has(goal.parentId)&&!hidden.has(goal.id)){hidden.add(goal.id);changed=true;}}
  return goals.filter(goal=>!hidden.has(goal.id));
}
async function storedGoals() {
  return usingSqlite()?database(db=>db.prepare('SELECT body FROM goals ORDER BY id').all().map(decode)):
    (await Promise.all((await numberedFiles(join(workspaceDirectory(),'goals'),/^([1-9][0-9]*)$/)).map(id=>readJson(goalPath(String(id)))))).filter(Boolean);
}
export async function listGoals({includeArchived=false}={}) {
  await initializeStore();
  const goals=await storedGoals();
  return includeArchived?goals:visibleGoals(goals);
}
function validateGoal(input) {
  const title=text(input.title,'Goal title',true);
  const scope=text(input.scope??'','Scope');
  const criteria=text(input.criteria??'','Success criteria');
  const parentId=input.parentId??null;
  if(parentId!==null) validId(parentId);
  const state=input.state??'idle';
  if(!['idle','waiting','done'].includes(state)) throw new Error('State must be idle, waiting, or done. Live Working tracking is separate.');
  if(input.started!==undefined&&typeof input.started!=='boolean') throw new Error('started must be boolean.');
  if(input.archived!==undefined&&typeof input.archived!=='boolean')throw Error('archived must be boolean.');
  if(input.archived&&parentId)throw Error('Archive a root Goal only.');
  const waitReason=state==='waiting'?text(input.waitReason??'','Waiting reason',true):'';
  const threadId=input.threadId??null;
  if(threadId!==null) validThreadId(threadId);
  if(parentId&&threadId) throw new Error('Assign a chat to the root Goal only.');
  return {title,scope,criteria,parentId,state,...(input.archived!==undefined?{archived:input.archived}:{}),started:state==='done'||Boolean(input.started),waitReason,threadId};
}
async function validateParent(id,parentId) {
  const seen=new Set([id]);
  while(parentId) {
    if(seen.has(parentId)) throw new Error('A Goal cannot be its own ancestor.');
    seen.add(parentId);
    const parent=await readGoal(parentId);
    if(!parent) throw new Error('Parent Goal not found.');
    if(parent.archived)throw Error('Restore the archived root before modifying its hierarchy.');
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
function subtreeIds(goals,id) {
  return new Set([id,...goals.filter(g=>g.parentId===id).flatMap(g=>[...subtreeIds(goals,g.id)])]);
}
function unfinishedDescendants(goals,id) {
  return goals.filter(g=>g.parentId===id).flatMap(g=>[
    ...(g.state==='done'?[]:[g]),...unfinishedDescendants(goals,g.id),
  ]);
}
export async function createGoal(input) {
  return createStoredGoal(input);
}
// A Root owned by a native conversation. Only a verified native hook reaches
// this, through its agent adapter, which builds the connection identity. Web/CLI
// create payloads cannot choose a connection.
const validIdentity=connection=>connection&&typeof connection==='object'&&typeof connection.sessionId==='string'&&connection.sessionId.trim()&&connection.sessionId.length<=512&&!/[\x00-\x1f\x7f]/.test(connection.sessionId);
export async function createConnectedRoot(input,connection,requestId) {
  if(!validIdentity(connection))throw Error('Invalid conversation identity.');
  validThreadId(connection.contextId);validThreadId(requestId);
  if(input.parentId||input.threadId)throw Error('Create a new root for this conversation, without a parent or another chat.');
  return createStoredGoal(input,{...connection},requestId);
}
// Taking over is the one explicit exception: a continued conversation (same
// work, new native session) adopts a Root through its verified main hook.
// The earlier owner is kept so feedback saved for it still reaches the new one.
export async function transferConnectedRoot(id,from,to,requestId) {
  validThreadId(requestId);
  if(!validIdentity(to))throw Error('Invalid conversation identity.');
  validThreadId(to.contextId);
  await initializeStore();
  return operation('tree',async()=>{
    const old=await readGoal(id);if(!old)throw Error('Goal not found.');
    if(old.parentId)throw Error('Only a root Goal belongs to a conversation.');
    if(old.transferRequestId===requestId&&sameConnection(old.connection,to))return old;
    if(!sameConnection(old.connection,from))throw Error('Goal ownership changed. Try again.');
    const goal={...old,connection:{...to},
      previousConnections:[...(old.previousConnections||[]),from],transferRequestId:requestId,updatedAt:new Date().toISOString()};
    await writeGoal(goal);await touch();return goal;
  });
}
async function createStoredGoal(input,connection,creationRequestId) {
  await initializeStore();
  return operation('tree',async()=>{
    const value=validateGoal(input);
    const goals=await listGoals({includeArchived:true});
    const creationHash=connection?createHash('sha256').update(JSON.stringify({value,connection})).digest('hex'):null;
    const existing=creationRequestId&&goals.find(g=>g.creationRequestId===creationRequestId);
    if(existing){
      await mkdir(join(workspaceDirectory(),'goals',existing.id),{recursive:true});
      if(existing.creationHash!==creationHash)throw Error('Root creation request changed.');
      // Recover an interrupted initial Deliverable write without overwriting edits.
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
  const allowed=['title','scope','criteria','parentId','state','started','waitReason','threadId','archived'];
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(k=>!allowed.includes(k))) throw new Error('Unknown Goal field.');
  await initializeStore();
  return operation('tree',async()=>{
    const old=await readGoal(id); if(!old) throw new Error('Goal not found.');
    // A Root moved under another Goal leaves its agent and its own settings: its
    // Goals follow the destination Root's agent, Autonomy, notifications and look.
    const rootMove=!old.parentId&&patch.parentId!=null;
    if(rootMove&&old.archived)throw Error('Restore the archived Root before moving it.');
    const value=validateGoal({...old,...(rootMove?{threadId:null}:{}),...patch});
    if(old.connection&&value.threadId)throw Error('A native conversation cannot be reassigned to a chat.');
    // A Goal leaving a conversation's Root becomes a Root of that same conversation,
    // with the Root's hand-off cursor, so `connection adopt` can hand it to another.
    // Goals moved into another Root take their comments not handed yet with them.
    let detachedFrom=null,moved=null;
    if(value.parentId!==old.parentId){
      const before=(await readGoalContext(id)).root;
      const after=value.parentId?(await readGoalContext(value.parentId)).root:null;
      if(before.connection&&!after&&before.id!==id)detachedFrom=before;
      else if(after&&before.id!==after.id)moved={from:before.id,to:after.id};
    }
    await validateParent(id,value.parentId);
    if(value.state==='done') {
      const unfinished=unfinishedDescendants(await listGoals({includeArchived:true}),id);
      if(unfinished.length)throw new Error(`Cannot mark Goal #${id} Done: unfinished SubGoals ${unfinished.slice(0,10).map(g=>`#${g.id} ${JSON.stringify(g.title)}`).join(', ')}${unfinished.length>10?` and ${unfinished.length-10} more`:''}. Verify and complete their agreed criteria first.`);
    }
    const goal={...old,...value,...(detachedFrom?{connection:{...detachedFrom.connection}}:{}),updatedAt:new Date().toISOString()};
    if(rootMove)for(const key of ['connection','previousConnections','transferRequestId','archived'])delete goal[key];
    if(goal.parentId!==old.parentId||(old.state==='done'&&goal.state!=='done'))await reopenAncestors(goal.parentId,goal.updatedAt);
    if(moved)await (await import('./hand-off.mjs')).moveComments({...moved,ids:subtreeIds(await listGoals({includeArchived:true}),id)},()=>writeGoal(goal));
    else await writeGoal(goal);
    if(rootMove)await (await import('./root-records.mjs')).forgetRoot(id);
    if(detachedFrom){
      const handOff=rootId=>join(workspaceDirectory(),'hand-off',`${rootId}.json`);
      const cursor=await readJson(handOff(detachedFrom.id));
      if(cursor)await writeJsonAtomically(handOff(id),{...cursor,held:false});
    }
    await touch(); return goal;
  });
}
export async function listVersions(id) { validId(id); if(usingSqlite())return database(db=>db.prepare('SELECT version FROM briefs WHERE goal_id=? ORDER BY version').all(Number(id)).map(row=>row.version)); return numberedFiles(briefDirectory(id),/^v([1-9][0-9]*)\.json$/); }
export async function readBrief(id,version) {
  validId(id);
  if(usingSqlite()) {
    if(version!==undefined&&(!Number.isSafeInteger(version)||version<1))throw Error('Deliverable version must be a positive integer.');
    return database(db=>decode(version===undefined?db.prepare('SELECT body FROM briefs WHERE goal_id=? ORDER BY version DESC LIMIT 1').get(Number(id)):db.prepare('SELECT body FROM briefs WHERE goal_id=? AND version=?').get(Number(id),version)));
  }
  const v=version??(await listVersions(id)).at(-1);
  if(v===undefined) return null;
  if(!Number.isSafeInteger(v)||v<1) throw new Error('Deliverable version must be a positive integer.');
  return readJson(join(briefDirectory(id),`v${v}.json`));
}
export async function briefSource(id,format) {
  if(!await readGoal(id))throw new Error('Goal not found.');
  const latest=await readBrief(id);
  format=validBriefFormat(format??latest?.format??'html');
  const path=briefPath(id,format);
  try {await writeFile(path,'',{flag:'wx',mode:0o600});} catch(error) {if(error.code!=='EEXIST')throw error;}
  return {goalId:id,format,path,latestVersion:latest?.version||0};
}
export async function updateBrief(id,format) {
  if(!await readGoal(id))throw new Error('Goal not found.');
  return operation(`brief-${id}`,async()=>{
    const previous=await readBrief(id);
    // Before the first version, publish whichever source was written; HTML by default.
    format=validBriefFormat(format??previous?.format??(!(await readFile(briefPath(id,'html'),'utf8').catch(()=>''))&&(await readFile(briefPath(id,'markdown'),'utf8').catch(()=>''))?'markdown':'html'));
    const path=briefPath(id,format),body=await readFile(path,'utf8');
    text(body,'Deliverable');
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
export async function readUserEventReferences() {
  if(usingSqlite())return database(db=>db.prepare("SELECT json_extract(body,'$.goalId') AS goalId,json_extract(body,'$.threadId') AS threadId,change_id AS changeId FROM events WHERE json_extract(body,'$.author')='user' AND json_extract(body,'$.threadId') IS NOT NULL").all());
  return (await readFeedback()).filter(e=>e.author==='user'&&e.threadId).map(({goalId,threadId,changeId})=>({goalId,threadId,changeId}));
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
// Each comment and Letter has a number within its Goal (1, 2, 3… in the order
// they were made), shown to people and agents beside the workspace-wide id.
// It is counted on read, never stored: records are never removed or moved and
// ids only grow, so a number never changes. A deleted comment keeps its number.
export const goalNumbers=rows=>{const numbers=new Map(),counts=new Map();for(const {goalId,id} of [...rows].sort((a,b)=>a.id-b.id)){const n=(counts.get(goalId)||0)+1;counts.set(goalId,n);numbers.set(id,n);}return numbers;};
export async function numberEvents(events) {
  if(!events.length)return events;
  if(usingSqlite())return database(db=>{
    const count=db.prepare('SELECT count(*) AS n FROM events WHERE goal_id=? AND id<=?');
    return events.map(event=>({...event,number:count.get(Number(event.goalId),event.id).n}));
  });
  const numbers=goalNumbers(await readFeedback());
  return events.map(event=>({...event,number:numbers.get(event.id)}));
}
export async function readConversationPage(goalId,{before,limit=30}={}) {
  validId(goalId);
  if(!Number.isSafeInteger(limit)||limit<1)throw Error('limit must be a positive integer.');
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
  if(item.attachmentIds!==undefined&&(!Array.isArray(item.attachmentIds)||item.attachmentIds.length>largeCount||new Set(item.attachmentIds).size!==item.attachmentIds.length)) throw new Error('Use distinct images in attachmentIds.');
  for(const id of feedbackImageIds(item)) if(!await attachmentInfo(id)) throw new Error('Image not found.');
}
export async function appendFeedback(input) { return appendEvent({...input,type:'comment',author:'user'}); }
export async function appendAgentComment(input) { return appendEvent({...input,author:'agent'}); }
// An agent message is a Comment, or with --ask a Letter titled with what the user is asked to decide.
export const agentMessageType=ask=>ask===undefined?{type:'comment'}:{type:'letter',title:ask};
// The agent withdraws a Letter whose question no longer needs an answer. A user
// Comment on the Goal closes its open Letters by itself (appendEvent).
export async function closeLetter(goalId,id,reason='') {
  if(!Number.isSafeInteger(id)||id<1)throw new Error('Letter event ID must be a positive integer.');
  text(reason,'Receipt reason');
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
// Delete an agent Comment or Letter posted by mistake. The event becomes an
// empty tombstone with a new change ID, so open Webs and cursors learn of it;
// readers skip tombstones. User comments are not deleted: they may already be
// on their way to an agent.
export async function deleteAgentComment(goalId,id) {
  if(!Number.isSafeInteger(id)||id<1)throw new Error('Event ID must be a positive integer.');
  await readGoalContext(goalId);
  return operation('events',async()=>{
    const events=await readFeedback(usingSqlite()?goalId:undefined),event=events.find(e=>e.id===id&&e.goalId===goalId);
    if(!event)throw new Error('Comment not found in this Goal.');
    if(event.author!=='agent')throw new Error('Only agent Comments and Letters can be deleted.');
    if(event.deletedAt)return {id,goalId,deleted:true,changed:false};
    const tombstone={id:event.id,changeId:await nextChangeId(events),goalId,author:event.author,type:event.type,text:'',title:'',attachmentIds:[],annotations:[],updatedAt:event.updatedAt,deletedAt:new Date().toISOString()};
    await writeEvent(tombstone);
    await touch();return {id,goalId,deleted:true,changed:true};
  });
}
async function appendEvent(input) {
  const allowed=['goalId','type','title','text','attachmentIds','annotations','requestId','author','replyRequired'];
  if(Object.keys(input).some(key=>!allowed.includes(key))) throw new Error('Unknown Conversation field.');
  const {goalId,type,title,text:message='',attachmentIds=[],requestId,author,replyRequired}=input;
  // Agents name the Deliverable as a source; records keep the internal kind.
  const annotations=Array.isArray(input.annotations)?input.annotations.map(n=>n?.source?.kind==='deliverable'?{...n,source:{...n.source,kind:'brief'}}:n):input.annotations??[];
  const {root}=await readGoalContext(goalId);
  if(!['comment','letter'].includes(type))throw new Error('Choose Comment to share an update, or Letter to ask for a user reply.');
  if(replyRequired!==undefined&&(type!=='letter'||typeof replyRequired!=='boolean'))throw new Error('replyRequired is a boolean for Letters only.');
  if(type==='letter'&&author!=='agent')throw new Error('Only an Agent can send a Letter.');
  if(type==='letter') {
    text(title,'Letter title',true);text(message,'Letter',true);
    if(/[\r\n]/.test(title.trim()))throw new Error('A Letter title (--ask) is one line: what the user is asked to decide.');
  }
  else if(title!==undefined)throw new Error('Titles belong to Letters.');
  text(message,'Comment');
  if(!Array.isArray(annotations)||annotations.length>largeCount) throw new Error('Annotations must be a list.');
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
      text(annotation.text,'Annotation'); await validateFeedbackImages(annotation);
      if(!annotation.text.trim()&&!feedbackImageIds(annotation).length) throw new Error('Add text or an image to the annotation.');
      if(annotation.kind==='letter') {
        if(author!=='user'||annotation.source?.kind!=='comment'||!Number.isSafeInteger(annotation.source.eventId))throw new Error('A Letter answer must refer to an Agent Letter.');
        if(!conversation.some(e=>e.id===annotation.source.eventId&&e.type==='letter'&&e.author==='agent'))throw new Error('Letter not found in this Goal.');
      } else if(annotation.kind==='text') {
        const a=annotation.anchor;
        if(!a||!Number.isSafeInteger(a.start)||!Number.isSafeInteger(a.end)||a.start<0||a.end<=a.start||typeof a.quote!=='string'||!a.quote.trim()) throw new Error('Invalid text annotation.');
        if(annotation.source?.kind==='comment') {
          const comment=conversation.find(e=>e.id===annotation.source.eventId&&e.author==='agent');
          const field=annotation.source.field;
          if(field!==undefined&&field!=='title')throw new Error('Annotation field must be title or omitted for the message text.');
          const sourceText=field==='title'?(comment?.type==='letter'?comment.title:undefined):comment?markdownText(comment.text):undefined;
          if(typeof sourceText!=='string'||a.end>sourceText.length||sourceText.slice(a.start,a.end).trim()!==a.quote.trim()) throw new Error('Annotation must quote an Agent comment or Letter title in this Goal.');
        } else if(annotation.source?.kind==='brief') {
          const brief=Number.isSafeInteger(annotation.source.version)?await readBrief(goalId,annotation.source.version):null;
          const sourceText=brief?briefText(brief.body,brief.format):null;
          if(sourceText===null||a.end>sourceText.length||sourceText.slice(a.start,a.end).trim()!==a.quote.trim())throw new Error('Annotation must quote an existing Deliverable version.');
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
        if(annotation.imageName!==undefined) text(annotation.imageName,'Image name',true);
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
    await writeEvent(event,true);
    // Once the user speaks on a Goal it is the agent's turn: the comment answers
    // the Goal's open Letters, whatever it is about. A question that still stands is asked again.
    if(author==='user') {
      let next=changeId;
      for(const letter of conversation.filter(e=>e.id<changeId&&letterState(e,conversation)?.status==='open'))
        await writeEvent({...letter,changeId:++next,receivedAt:event.updatedAt,answeredBy:changeId});
    }
    await touch();return event;
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

// Any file can be attached. A PNG, JPEG or WebP whose bytes match is an image
// shown inline; anything else keeps its name and declared type beside it.
const isPdf = data => data.toString('latin1', 0, 5) === '%PDF-';
export async function saveAttachment(data, mimeType, name = '') {
  if (!Buffer.isBuffer(data) || !data.length || data.length > largeSize) throw new Error('Choose a file that is not empty.');
  const type = imageTypes.get(mimeType);
  if (type && !type.matches(data)) throw new Error(`This file is not a valid ${type.extension.toUpperCase()} image.`);
  const id = randomUUID();
  const directory = join(workspaceDirectory(), 'attachments');
  await mkdir(directory, { recursive: true });
  if (type) {
    await writeFile(join(directory, `${id}.${type.extension}`), data, { flag: 'wx', mode: 0o600 });
    await recordServerUse(dataDirectory());
    return { id, mimeType };
  }
  const declared = typeof mimeType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(mimeType) ? mimeType : 'application/octet-stream';
  const file = { name: String(name).replace(/[\x00-\x1f\x7f/\\]/g, '').trim() || 'file', mimeType: declared, pdf: isPdf(data) };
  await writeFile(join(directory, `${id}.file`), data, { flag: 'wx', mode: 0o600 });
  await writeFile(join(directory, `${id}.json`), JSON.stringify(file), { flag: 'wx', mode: 0o600 });
  await recordServerUse(dataDirectory());
  return { id, mimeType: declared, name: file.name };
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
  try {
    const file = JSON.parse(await readFile(join(workspaceDirectory(), 'attachments', `${id}.json`), 'utf8'));
    return { id, path: join(workspaceDirectory(), 'attachments', `${id}.file`), mimeType: file.mimeType, name: file.name, pdf: file.pdf === true };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return null;
}
