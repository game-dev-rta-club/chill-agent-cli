import {overlayPausedGoals} from './agent-activity.mjs';
import {listStoredGoals,workspaceTree,validId,attachmentInfo,feedbackImageIds} from './goal-store.mjs';
import {refreshExecutions,executionForGoals} from './goal-execution.mjs';
import {renderedEvent} from './markdown.mjs';
import {briefHTML} from './brief.mjs';
export async function readConnectedGoals() {
  await refreshExecutions();
  const goals=await listStoredGoals(),executions=await overlayPausedGoals(goals,await executionForGoals(goals));
  return goals.map(goal=>({...goal,conversation:goal.conversation.map(renderedEvent),briefs:goal.briefs.map(o=>({...o,html:briefHTML(o.body,o.format)})),execution:executions.get(goal.id)||null}));
}
export async function readConnectedTree(id) {return workspaceTree(await readConnectedGoals(),id);}

export const goalURL=(id,version)=>`http://127.0.0.1:${process.env.PORT||4173}/#/goal/${id}${version?`/v${version}`:''}`;
const outline=node=>{
  const {children,letters,...goal}=node;
  return {...goal,url:goalURL(goal.id)};
};

// Brief history never rolls back the current Goal tree or Conversation.
export function goalPage(goals,id,{version,since=0}={}) {
  validId(id);
  if(!Number.isSafeInteger(since)||since<0) throw new Error('--since must be a non-negative integer.');
  if(version!==undefined&&(!Number.isSafeInteger(version)||version<1)) throw new Error('Brief version must be a positive integer.');
  const stored=goals.find(g=>g.id===id);
  if(!stored) throw new Error('Goal not found.');
  const path=[];
  let current=stored;
  while(current) {
    if(path.some(g=>g.id===current.id)) throw new Error('Goal hierarchy contains a cycle.');
    path.unshift(current);
    if(!current.parentId)break;
    current=goals.find(g=>g.id===current.parentId);
    if(!current)throw new Error('Parent Goal not found.');
  }
  const rootTree=workspaceTree(goals,path[0].id)[0];
  const nodes=new Map();
  function index(node) {nodes.set(node.id,node);node.children.forEach(index);}
  index(rootTree);
  const node=nodes.get(id),brief=version===undefined?stored.briefs.at(-1)||null:stored.briefs.find(n=>n.version===version);
  if(version!==undefined&&!brief) throw new Error('Brief not found.');
  const conversation=stored.conversation;
  const cursor=goals.reduce((max,g)=>g.conversation.reduce((n,e)=>Math.max(n,e.changeId),max),0);
  const addLinks=branch=>({...branch,url:goalURL(branch.id),letters:branch.letters.map(l=>({...l,url:`${goalURL(l.goalId)}/letter/${l.id}`})),children:branch.children.map(addLinks)});
  const subtree=addLinks(node);
  const letters=[];
  function collect(branch) {letters.push(...branch.letters);branch.children.forEach(collect);}
  collect(subtree);
  const {briefs,conversation:ignored,execution,...metadata}=stored;
  const root=path[0];
  return {
    goal:{...metadata,...outline(node),storedState:stored.state},
    root:{...outline(rootTree),threadId:root.threadId,branches:rootTree.children.map(outline)},
    ancestors:path.slice(0,-1).map(({id,title})=>({id,title})),
    splitGoals:subtree.children,letters,
    versions:stored.briefs.map(o=>({version:o.version,format:o.format,createdAt:o.createdAt,selected:o.version===brief?.version,url:goalURL(id,o.version)})),
    brief,
    latestVersion:stored.briefs.at(-1)?.version||0,
    answerTargets:[...new Set(conversation.filter(e=>e.changeId>since).flatMap(e=>(e.annotations||[]).filter(n=>n.kind==='letter').map(n=>n.source.eventId)))].map(id=>conversation.find(e=>e.id===id)),
    conversation:conversation.filter(e=>e.changeId>since),
    conversationInfo:{since,cursor,total:conversation.length,returned:conversation.filter(e=>e.changeId>since).length},
    url:goalURL(id,brief?.version),
  };
}
export async function readGoalPage(id,options) {
  const page=goalPage(await readConnectedGoals(),id,options);
  const ids=new Set(page.conversation.flatMap(e=>[...feedbackImageIds(e),...(e.annotations||[]).flatMap(n=>[...feedbackImageIds(n),...(n.imageId?[n.imageId]:[])])]));
  for(const match of (page.brief?.body||'').matchAll(/\/api\/images\/([0-9a-f-]{36})/g)) ids.add(match[1]);
  return {...page,attachments:(await Promise.all([...ids].map(attachmentInfo))).filter(Boolean)};
}
