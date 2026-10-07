// Saved agreement and substantive revision, independent of native execution facts.
import {createHash} from 'node:crypto';
import {listGoals,readFeedback,readBrief,readOpenLetters,workspaceTree} from './goal-store.mjs';
import {summarizeGoals} from './goal-review.mjs';
import {continuationExcerpt} from './continuation-excerpt.mjs';
export async function continuationWorkspace(rootId) {
 const goals=await listGoals(),root=goals.find(g=>g.id===rootId);
 if(!root||root.parentId)throw Error('A Root Goal is required.');
 const belongs=g=>{while(g.parentId)g=goals.find(p=>p.id===g.parentId);return g.id===rootId;};
 const branch=goals.filter(belongs);
 const allEvents=await readFeedback();
 const userEvent=Math.max(0,...allEvents.filter(e=>e.author==='user'&&branch.some(g=>g.id===e.goalId)).map(e=>e.changeId));
 const contents=await Promise.all(branch.sort((a,b)=>Number(a.id)-Number(b.id)).map(async g=>{
  const brief=await readBrief(g.id);
  return {id:g.id,parentId:g.parentId,title:g.title,scope:g.scope,criteria:g.criteria,state:g.state,waitReason:g.waitReason,threadId:g.threadId,...(g.connection?{connection:g.connection}:{}),
   brief:brief?{format:brief.format,body:brief.body}:null};
 }));
 const revision=createHash('sha256').update(JSON.stringify({userEvent,contents})).digest('hex');
 const inBranch=event=>branch.some(g=>g.id===event.goalId);
 const latestUser=allEvents.filter(e=>e.author==='user'&&inBranch(e)).at(-1);
 const latestReport=allEvents.filter(e=>e.author==='agent'&&e.type==='comment'&&inBranch(e)).at(-1);
 const focus=branch.find(g=>g.id===latestUser?.goalId)||root;
 const excerpt=e=>e?continuationExcerpt([e.text,...(e.annotations||[]).map(n=>n.text)].filter(Boolean).join(' ')):'';
 const context={focus:{id:focus.id,title:focus.title},latestRequest:excerpt(latestUser),latestReport:excerpt(latestReport),
  goals:summarizeGoals(workspaceTree(branch.map(g=>({...g,briefs:[],conversation:allEvents.filter(e=>e.goalId===g.id)})),rootId)),
  openGoals:branch.filter(g=>g.id!==rootId&&g.state!=='done').map(g=>({id:g.id,title:g.title})),
  letters:(await readOpenLetters(rootId)).map(e=>({id:e.id||e.changeId,title:e.title,goalId:e.goalId}))};
 return {root,goals,branch,allEvents,revision,userEvent,context};
}
