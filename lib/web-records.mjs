import {workspaceDirectory,listStoredGoals,visibleGoals} from './goal-store.mjs';
import {sqliteSelected,withDatabase,decode} from './workspace-records.mjs';
import {letterState} from '../public/letter-state.js';

// Return metadata for every Letter, not every historical Letter body. This lets
// the browser update cached pages when a reply falls outside the newest page.
export async function listWebRecords() {
 const directory=workspaceDirectory();
 if(!sqliteSelected(directory))return (await listStoredGoals()).map(goal=>{
  const ordered=[...goal.conversation].sort((a,b)=>a.changeId-b.changeId),page=ordered.slice(-30);
  const states=goal.conversation.filter(e=>e.type==='letter'&&e.author==='agent').map(e=>({id:e.id,...letterState(e,goal.conversation)}));
  const wanted=new Set([...page.map(e=>e.id),...states.filter(s=>s.status==='open').map(s=>s.id),...page.flatMap(e=>(e.annotations||[]).filter(n=>n.kind==='letter').map(n=>n.source.eventId))]);
  return {...goal,letterStates:states,conversation:goal.conversation.filter(e=>wanted.has(e.id)),conversationInfo:{head:page[0]?.changeId||0,hasMore:ordered.length>30,nextBefore:ordered.length>30?page[0].changeId:null}};
 });
 return withDatabase(directory,db=>{
  db.exec('BEGIN');
  try {
   const goals=visibleGoals(db.prepare('SELECT body FROM goals ORDER BY id').all().map(decode));
   const result=goals.map(goal=>{
    const id=Number(goal.id);
    const briefs=db.prepare("SELECT version,json_extract(body,'$.format') AS format,json_extract(body,'$.createdAt') AS createdAt FROM briefs WHERE goal_id=? ORDER BY version").all(id);
    if(briefs.length)briefs[briefs.length-1]=decode(db.prepare('SELECT body FROM briefs WHERE goal_id=? ORDER BY version DESC LIMIT 1').get(id));
    const rows=db.prepare('SELECT body FROM events WHERE goal_id=? ORDER BY change_id DESC LIMIT 31').all(id).map(decode);
    const page=rows.slice(0,30).reverse();
    const answers=new Map(db.prepare(`SELECT json_extract(n.value,'$.source.eventId') AS target,max(e.id) AS answer
      FROM events e,json_each(e.body,'$.annotations') n WHERE e.goal_id=? AND json_extract(e.body,'$.author')='user'
      AND json_extract(n.value,'$.kind')='letter' AND json_extract(n.value,'$.source.kind')='comment' GROUP BY target`).all(id).map(r=>[r.target,r.answer]));
    const states=db.prepare(`SELECT id,json_extract(body,'$.replyRequired') AS replyRequired,json_extract(body,'$.receivedAt') AS receivedAt
      FROM events WHERE goal_id=? AND json_extract(body,'$.type')='letter' AND json_extract(body,'$.author')='agent'`).all(id).map(row=>({id:row.id,status:row.replyRequired===0?'notice':row.receivedAt?'received':answers.has(row.id)?'answered':'open',lastAnswerId:row.replyRequired===0?null:answers.get(row.id)||null}));
    const wanted=new Set([...states.filter(s=>s.status==='open').map(s=>s.id),...page.flatMap(e=>(e.annotations||[]).filter(n=>n.kind==='letter').map(n=>n.source.eventId))]);
    const events=new Map(page.map(e=>[e.id,e]));
    for(const eventId of wanted)if(!events.has(eventId)){const event=decode(db.prepare('SELECT body FROM events WHERE id=? AND goal_id=?').get(eventId,id));if(event)events.set(eventId,event);}
    return {...goal,briefs,letterStates:states,conversation:[...events.values()],conversationInfo:{head:page[0]?.changeId||0,hasMore:rows.length>30,nextBefore:rows.length>30?page[0].changeId:null}};
   });
   db.exec('COMMIT');return result;
  }catch(error){db.exec('ROLLBACK');throw error;}
 });
}
