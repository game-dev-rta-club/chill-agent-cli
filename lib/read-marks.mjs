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
export async function readThroughFor(goalId){return (await readThroughByGoal())(goalId);}
// Changes whenever any read mark does.
export const readMarksVersion=async()=>JSON.stringify(await readJson(file()));
// Each Goal with its read mark and the announced replies saved after it: a reply
// counts as unread once its Root's work ends. A Root also says what this
// browser's count shows.
export async function readAttention(clientId){
  const [through,announced,counts]=await Promise.all([readThroughByGoal(),webNotifications.announcedReplies(),webNotifications.counts(clientId)]);
  return (goal,conversation)=>{
    const readThrough=through(goal.id);
    return {...goal,readThrough,announced:conversation.filter(e=>e.goalId===goal.id&&e.id>readThrough&&announced.has(e.id)).map(e=>e.id),...(goal.parentId?{}:{counts:counts(goal.id)})};
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
