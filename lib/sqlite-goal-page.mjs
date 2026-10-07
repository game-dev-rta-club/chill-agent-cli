// A single read snapshot for the CLI page: hierarchy/Letter summaries plus only
// the requested Goal's event range and selected Brief body.
import {workspaceDirectory,briefPath} from './goal-store.mjs';
import {withDatabase,decode} from './workspace-records.mjs';
export async function sqliteGoalPageRecords(id,{version,since=0,before,limit}={}) {
 return withDatabase(workspaceDirectory(),db=>{
  db.exec('BEGIN');
  try{
   const goals=db.prepare('SELECT body FROM goals ORDER BY id').all().map(decode);
   if(!goals.some(g=>g.id===id))throw Error('Goal not found.');
   const goalId=Number(id),bounds=[goalId,since,before??Number.MAX_SAFE_INTEGER];
   const range='goal_id=? AND change_id>? AND change_id<?';
   const events=db.prepare(`SELECT body FROM events WHERE ${range} ORDER BY change_id DESC${limit===undefined?'':' LIMIT ?'}`).all(...bounds,...(limit===undefined?[]:[limit])).map(decode).reverse();
   const matching=db.prepare(`SELECT count(*) AS n FROM events WHERE ${range}`).get(...bounds).n;
   const total=db.prepare('SELECT count(*) AS n FROM events WHERE goal_id=?').get(goalId).n;
   const cursor=db.prepare('SELECT coalesce(max(change_id),0) AS n FROM events').get().n;
   const answerTargets=[...new Set(events.flatMap(e=>(e.annotations||[]).filter(n=>n.kind==='letter').map(n=>n.source.eventId)))].map(eventId=>decode(db.prepare('SELECT body FROM events WHERE id=? AND goal_id=?').get(eventId,goalId))).filter(Boolean);
   // Replies may be outside the requested range. Determine openness in SQL,
   // rather than materializing historical comment and reply bodies in JavaScript.
   const open=db.prepare(`SELECT l.body FROM events l WHERE json_extract(l.body,'$.type')='letter'
    AND json_extract(l.body,'$.author')='agent' AND coalesce(json_extract(l.body,'$.replyRequired'),1)<>0
    AND json_extract(l.body,'$.receivedAt') IS NULL AND NOT EXISTS (
     SELECT 1 FROM events r,json_each(r.body,'$.annotations') n WHERE r.goal_id=l.goal_id
     AND json_extract(r.body,'$.author')='user' AND json_extract(n.value,'$.kind')='letter'
     AND json_extract(n.value,'$.source.kind')='comment' AND json_extract(n.value,'$.source.eventId')=l.id
    )`).all().map(decode).sort((a,b)=>Date.parse(a.updatedAt)-Date.parse(b.updatedAt)||a.id-b.id);
   for(const goal of goals){
    goal.briefs=db.prepare("SELECT version,json_extract(body,'$.format') AS format,json_extract(body,'$.createdAt') AS createdAt FROM briefs WHERE goal_id=? ORDER BY version").all(Number(goal.id));
    goal.briefPath=briefPath(goal.id,goal.briefs.at(-1)?.format);
    goal.conversation=open.filter(e=>e.goalId===goal.id);
    if(goal.id===id){
     const selected=version??goal.briefs.at(-1)?.version;
     if(selected!==undefined){
      const index=goal.briefs.findIndex(b=>b.version===selected);
      if(index<0)throw Error('Brief not found.');
      goal.briefs[index]=decode(db.prepare('SELECT body FROM briefs WHERE goal_id=? AND version=?').get(goalId,selected));
     }
    }
   }
   db.exec('COMMIT');return {goals,selection:{events,answerTargets,total,cursor,remaining:matching-events.length}};
  }catch(error){db.exec('ROLLBACK');throw error;}
 });
}
