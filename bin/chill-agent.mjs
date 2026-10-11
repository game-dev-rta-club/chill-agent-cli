#!/usr/bin/env node
import '../lib/quiet-sqlite-warning.mjs';
import {workspacePort} from '../lib/project-workspace.mjs';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import { appendAgentComment, appendFeedback, closeLetter, createGoal, updateGoal, readGoalContext, briefSource, updateBrief, initializeStore, checkFeedback, saveAttachment } from '../lib/goal-store.mjs';
import { deliverFeedback, prepareDelivery, recordActivity } from '../lib/delivery.mjs';
import { parseOptions, showHelp } from '../lib/cli-help.mjs';
import {assignGoal,selectWork} from '../lib/goal-execution.mjs';
import {readConnectedTree,readGoalPage} from '../lib/workspace-reader.mjs';
import {renderGoalPage} from '../lib/goal-page-text.mjs';
import {reviewGoals,renderGoalReview} from '../lib/goal-review.mjs';

const output=value=>console.log(JSON.stringify(value,null,2));
const url=(id,version)=>`http://127.0.0.1:${workspacePort()}/#/goal/${id}${version?`/v${version}`:''}`;
async function input(path) {
  let raw='';
  if(path==='-') for await(const chunk of process.stdin) { raw+=chunk; if(raw.length>160000) throw new Error('Request is too large.'); }
  else raw=await readFile(path,'utf8');
  if(raw.length>160000) throw new Error('Request is too large.');
  return JSON.parse(raw);
}
async function main() {
  const args=process.argv.slice(2);
  if(showHelp('goal',args.length?args:['--help'])) return;
  const [command,...rest]=args;
  const subcommand=command==='brief'?rest.shift():null;
  const v=parseOptions(`goal ${command}${subcommand?` ${subcommand}`:''}`,rest);
  await initializeStore();
  const id=v['--id'];
  if(command==='create') {
    const goal=await createGoal({title:v['--title'],parentId:v['--parent'],scope:v['--scope'],criteria:v['--criteria'],threadId:v['--thread-id']});
    return output({...goal,url:url(goal.id)});
  }
  if(command==='update') {
    const patch=await input(v['--input-file']),goal=await updateGoal(id,patch);
    if(patch.state!=='done')return output(goal);
    const {path}=await readGoalContext(id);
    return output({...goal,nextActions:{message:'Review parent and ancestor success criteria. Mark only achieved Goals Done; otherwise leave them Open. This reminder does not require changing their state.',ancestors:path.slice(0,-1).reverse().map(({id,title,criteria,state})=>({id,title,criteria,state}))}});
  }
  if(command==='close-letter')return output(await closeLetter(id,Number(v['--event']),v['--reason']));
  if(command==='brief') {
    const result=subcommand==='path'?await briefSource(id,v['--format']):await updateBrief(id,v['--format']);
    return output({...result,url:url(id,result.version)});
  }
  if(command==='assign') return output(await assignGoal(id,v['--off']?null:v['--thread-id']));
  if(command==='work') return output(await selectWork(id,{stop:Boolean(v['--stop'])}));
  if(command==='tree') return output(await readConnectedTree(id));
  if(command==='review') {
    return console.log(renderGoalReview(reviewGoals(await readConnectedTree(id),{state:v['--state'],letters:Boolean(v['--letters']),after:v['--after'],limit:Number(v['--limit']??50)})));
  }
  if(command==='show') {
    const text=v['--format']==='text',full=Boolean(v['--full']);
    if(full&&v['--limit']!==undefined)throw Error('Use --full or --limit, not both.');
    if(!text&&(v['--section']||v['--brief-offset']))throw Error('--section and --brief-offset require --format text.');
    // Explicit --since is the feedback delivery boundary: do not silently drop newer instructions.
    const limit=v['--limit']!==undefined?Number(v['--limit']):text&&!full&&v['--since']===undefined?5:undefined;
    const page=await readGoalPage(id,{version:v['--version']===undefined?undefined:Number(v['--version']),since:Number(v['--since']??0),before:v['--before']===undefined?undefined:Number(v['--before']),limit});
    return text?console.log(renderGoalPage(page,{full,section:v['--section'],briefOffset:Number(v['--brief-offset']??0)})):output(page);
  }
  if(command==='comment'||command==='letter') {
    const event=await appendAgentComment({goalId:id,type:command,...(command==='letter'?{title:v['--title'],...(v['--no-reply']?{replyRequired:false}:{})}:{ }),text:v['--text-file']?await readFile(v['--text-file'],'utf8'):v['--text']});
    return output({...event,url:command==='letter'?`${url(id)}/letter/${event.id}`:url(id)});
  }
  if(command==='check') return output(await checkFeedback({goalId:id,since:Number(v['--since']??0)}));
  if(command==='feedback') {
    const feedback=await appendFeedback({...await input(v['--input-file']),goalId:id});
    const delivery=await prepareDelivery(feedback);
    console.log(JSON.stringify({feedback,delivery}));
    console.log(JSON.stringify({delivery:await deliverFeedback(feedback.changeId)})); return;
  }
  if(command==='image') {
    const mimeType={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'}[extname(v['--file']).toLowerCase()];
    const image=await saveAttachment(await readFile(v['--file']),mimeType);
    return output({...image,src:`/api/images/${image.id}`});
  }
  if(command==='activity') return output({delivery:await recordActivity(v['--event'],v['--state'])});
  if(command==='retry') return console.log(JSON.stringify({delivery:await deliverFeedback(v['--event'])}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
