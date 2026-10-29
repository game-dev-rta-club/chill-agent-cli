#!/usr/bin/env node
import '../lib/quiet-sqlite-warning.mjs';
import {workspacePort} from '../lib/project-workspace.mjs';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import { appendFeedback, closeLetter, deleteAgentComment, updateGoal, readGoalContext, briefSource, updateBrief, initializeStore, checkFeedback, saveAttachment } from '../lib/goal-store.mjs';
import { deliverFeedback, sendFeedbackNow } from '../lib/delivery.mjs';
import { parseOptions, showHelp } from '../lib/cli-help.mjs';
import {selectAgentWork} from '../lib/agents/index.mjs';
import {adoptRoot,createRootOrGoal,readInbox,releaseRoot,replyOnGoal} from '../lib/agent-actions.mjs';
import {readConnectedTree,readGoalPage} from '../lib/workspace-reader.mjs';
import {renderGoalPage} from '../lib/goal-page-text.mjs';
import {reviewGoals,renderGoalReview} from '../lib/goal-review.mjs';
import {largeSize} from '../lib/limits.mjs';
import {briefLayoutHint} from '../lib/brief.mjs';

// Agents see the Deliverable by that name; stored records keep their internal names.
const agentNames={brief:'deliverable',briefs:'deliverables',briefPath:'deliverablePath'};
const forAgents=value=>Array.isArray(value)?value.map(forAgents):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[agentNames[key]||key,key==='kind'&&item==='brief'?'deliverable':forAgents(item)])):value;
const output=value=>console.log(JSON.stringify(forAgents(value),null,2));
const url=(id,version)=>`http://127.0.0.1:${workspacePort()}/#/goal/${id}${version?`/v${version}`:''}`;
async function input(path) {
  let raw='';
  if(path==='-') for await(const chunk of process.stdin) { raw+=chunk; if(raw.length>largeSize) throw new Error('Request is too large.'); }
  else raw=await readFile(path,'utf8');
  if(raw.length>largeSize) throw new Error('Request is too large.');
  return JSON.parse(raw);
}
async function main() {
  const args=process.argv.slice(2);
  if(showHelp('goal',args.length?args:['--help'])) return;
  const [command,...rest]=args;
  if(command==='brief')throw Error('goal brief was renamed to goal deliverable.');
  const subcommand=command==='deliverable'?rest.shift():null;
  const v=parseOptions(`goal ${command}${subcommand?` ${subcommand}`:''}`,rest);
  await initializeStore();
  const id=v['--id'];
  if(command==='create') {
    const {goal,text}=await createRootOrGoal({title:v['--title'],parentId:v['--parent'],scope:v['--scope'],criteria:v['--criteria']});
    return output({...goal,url:url(goal.id),...(text?{message:text}:{})});
  }
  if(command==='update') {
    const patch=await input(v['--input-file']),goal=await updateGoal(id,patch);
    if(patch.state!=='done')return output(goal);
    const {path}=await readGoalContext(id);
    return output({...goal,nextActions:{message:'Review parent and ancestor success criteria. Mark only achieved Goals Done; otherwise leave them Open. This reminder does not require changing their state.',ancestors:path.slice(0,-1).reverse().map(({id,title,criteria,state})=>({id,title,criteria,state}))}});
  }
  if(command==='close-letter')return output(await closeLetter(id,Number(v['--event']),v['--reason']));
  if(command==='delete-comment')return output(await deleteAgentComment(id,Number(v['--event'])));
  if(command==='deliverable') {
    const result=subcommand==='path'?await briefSource(id,v['--format']):await updateBrief(id,v['--format']);
    // An unchanged file usually means the edit never reached it, so say so as a failure.
    if(result.changed===false)throw Error(`Not published: ${result.path} is the same as v${result.version}. Check that the edit was saved, then run deliverable update again.`);
    const hint=subcommand==='update'&&briefLayoutHint(result.body,result.format);
    return output({...result,url:url(id,result.version),...(hint?{hint}:{})});
  }
  if(command==='adopt') return output(await adoptRoot(id));
  if(command==='release') return output(await releaseRoot(id));
  if(command==='inbox') return console.log(await readInbox());
  if(command==='work') return output(await selectAgentWork(id,{stop:Boolean(v['--stop'])}));
  if(command==='tree') return output(await readConnectedTree(id));
  if(command==='review') {
    return console.log(renderGoalReview(reviewGoals(await readConnectedTree(id),{state:v['--state'],letters:Boolean(v['--letters']),after:v['--after'],limit:Number(v['--limit']??50)})));
  }
  if(command==='show') {
    const text=v['--format']==='text',full=Boolean(v['--full']);
    if(full&&v['--limit']!==undefined)throw Error('Use --full or --limit, not both.');
    if(!text&&(v['--section']||v['--deliverable-offset']))throw Error('--section and --deliverable-offset require --format text.');
    // Explicit --since is the feedback delivery boundary: do not silently drop newer instructions.
    const limit=v['--limit']!==undefined?Number(v['--limit']):text&&!full&&v['--since']===undefined?5:undefined;
    const page=await readGoalPage(id,{version:v['--version']===undefined?undefined:Number(v['--version']),since:Number(v['--since']??0),before:v['--before']===undefined?undefined:Number(v['--before']),limit});
    return text?console.log(renderGoalPage(page,{full,section:v['--section'],briefOffset:Number(v['--deliverable-offset']??0)})):output(page);
  }
  if(command==='reply') {
    const {comment:event,text}=await replyOnGoal({goalId:id,ask:v['--ask'],text:v['--text-file']?await readFile(v['--text-file'],'utf8'):v['--text']});
    return output({...event,url:event.type==='letter'?`${url(id)}/letter/${event.id}`:url(id),message:text});
  }
  if(command==='check') return output(await checkFeedback({goalId:id,since:Number(v['--since']??0)}));
  if(command==='feedback') {
    const feedback=await appendFeedback({...await input(v['--input-file']),goalId:id});
    console.log(JSON.stringify({feedback}));
    console.log(JSON.stringify({comment:await deliverFeedback(feedback.changeId)})); return;
  }
  if(command==='image') {
    const mimeType={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'}[extname(v['--file']).toLowerCase()];
    // Other files keep their own name, so a download gets the same extension.
    const image=await saveAttachment(await readFile(v['--file']),mimeType,basename(v['--file']));
    return output({...image,src:`/api/images/${image.id}`});
  }
  if(command==='send-now') return console.log(JSON.stringify({comment:await sendFeedbackNow(v['--event'])}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
