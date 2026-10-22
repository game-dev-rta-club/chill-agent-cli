import {join} from 'node:path';
import {readFeedback,workspaceDirectory,validId} from './goal-store.mjs';
import {readJson,writeJsonAtomically,withStoreLock} from './storage.mjs';
import {webNotifications} from './web-notifications.mjs';

// The newest event the user has seen in each Goal, shared by every device.
// Everything saved before the first read counts as read.
const file=()=>join(workspaceDirectory(),'read-marks.json');
const lock=run=>withStoreLock(join(workspaceDirectory(),'locks','read-marks'),run);
const latestEventId=async()=>(await readFeedback()).reduce((n,e)=>Math.max(n,e.id),0);
async function current(){
  const marks=await readJson(file());
  if(marks)return marks;
  return lock(async()=>{
    const again=await readJson(file());if(again)return again;
    const fresh={since:await latestEventId(),goals:{}};await writeJsonAtomically(file(),fresh);return fresh;
  });
}
async function readThroughByGoal(){
  const {since,goals}=await current();
  return id=>goals[id]??since;
}
// Each Goal with its read mark and the notified replies saved after it: only a
// reply that reached a device counts as unread.
export async function readAttention(){
  const [through,notified]=await Promise.all([readThroughByGoal(),webNotifications.notifiedReplies()]);
  return (goal,conversation)=>{
    const readThrough=through(goal.id);
    return {...goal,readThrough,notified:conversation.filter(e=>e.goalId===goal.id&&e.id>readThrough&&notified.has(e.id)).map(e=>e.id)};
  };
}
export async function markRead(goalId,through){
  validId(goalId);
  if(!Number.isSafeInteger(through)||through<1)throw Error('through must be a positive event ID.');
  await current();
  return lock(async()=>{
    const marks=await readJson(file());
    marks.goals[goalId]=Math.max(marks.goals[goalId]??marks.since,through);
    await writeJsonAtomically(file(),marks);
    return {readThrough:marks.goals[goalId]};
  });
}
