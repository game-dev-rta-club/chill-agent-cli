import {join} from 'node:path';
import {readFeedback,workspaceDirectory,validId} from './goal-store.mjs';
import {readJson,writeJsonAtomically,withStoreLock} from './storage.mjs';

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
export async function readThroughByGoal(){
  const {since,goals}=await current();
  return id=>goals[id]??since;
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
