// Autonomy (public/autonomy.js) as the agent meets it: one message at the end
// of a turn, and tool approvals. A conversation's levels are those of the Roots
// it owns (root-autonomy); the rules are the same for every harness.
import {autonomyLevels,autonomyOf} from '../public/autonomy.js';
import {listGoals,readFeedback} from './goal-store.mjs';
import {ownsRoot} from './owner.mjs';
import {ownedWorkspace} from './continuation-workspace.mjs';
import {rootAutonomy} from './root-autonomy.mjs';
export {autonomyLevels,autonomyOf};

const name=level=>autonomyLevels[level-1].name;
const ultra=3;
const byNumber=(a,b)=>Number(a.id)-Number(b.id);

// The Roots `owner` holds, each with its agent's level.
export async function ownedRootLevels(owner,goals){
  const roots=(goals??await listGoals()).filter(ownsRoot(owner)).sort(byNumber);
  return Promise.all(roots.map(async root=>({root,level:await rootAutonomy(root)})));
}
// Tool approvals: a prompt carries no Goal, so the Root the user wrote to last
// decides, the one whose tree holds their latest comment; with no comment in
// any owned Root, the newest Root. Its level at Auto Continue or Ultra Continue
// allows. Owning none means asking. `levels` is ownedRootLevels'.
export function approvesTools(levels,{goals=[],events=[]}={}){
  if(!levels.length)return false;
  const byId=new Map(goals.map(g=>[g.id,g]));
  const rootOf=id=>{let goal=byId.get(id);const seen=new Set();while(goal?.parentId&&!seen.has(goal.id)){seen.add(goal.id);goal=byId.get(goal.parentId);}return goal?.id;};
  const latest=new Map();
  for(const event of events)if(event.author==='user'){const root=rootOf(event.goalId);if(root)latest.set(root,Math.max(latest.get(root)??0,event.changeId??0));}
  const [deciding]=[...levels].sort((a,b)=>(latest.get(b.root.id)??0)-(latest.get(a.root.id)??0)||Number(b.root.id)-Number(a.root.id));
  return deciding.level>=2;
}
// Whether `owner`'s tool prompts are allowed now (approvesTools).
export async function readToolApproval(owner){
  const goals=await listGoals();
  return approvesTools(await ownedRootLevels(owner,goals),{goals,events:await readFeedback()});
}

// The end-of-turn plan for one conversation: its unfinished owned Roots above
// Normal, the highest level among them, and for each Root at Ultra Continue its
// unfinished Goals, without those other live conversations hold (`held`). Null
// when no Root asks for anything; a Done Root asks for nothing.
export function turnPlan({goals,levels,held=new Set()}) {
  const listed=levels.filter(({root,level})=>level>=2&&root.state!=='done');
  if(!listed.length)return null;
  const byId=new Map(goals.map(g=>[g.id,g]));
  const rootOf=goal=>{const seen=new Set();while(goal?.parentId&&!seen.has(goal.id)){seen.add(goal.id);goal=byId.get(goal.parentId);}return goal;};
  const brief=goal=>({id:goal.id,title:goal.title});
  const level=Math.max(...listed.map(r=>r.level)),top=listed.find(r=>r.level===level).root;
  const roots=listed.map(({root,level})=>{
    if(level!==ultra)return {...brief(root),level};
    const open=goals.filter(goal=>goal.state!=='done'&&rootOf(goal)?.id===root.id);
    return {...brief(root),level,open:open.filter(goal=>!held.has(goal.id)).map(brief),taken:open.filter(goal=>held.has(goal.id)).map(brief)};
  });
  return {level,rootId:top.id,goalId:top.id,goalTitle:top.title,roots};
}

const quote=title=>`“${String(title||'Goal').slice(0,100)}”`;
const some=(goals,limit=8)=>goals.slice(0,limit).map(goal=>`#${goal.id} ${quote(goal.title)}`).join(', ')+(goals.length>limit?`, and ${goals.length-limit} more`:'');
const meaning={
  2:root=>`After each turn, keep carrying out what you and the user clearly see the same way, in any Goal under Root Goal #${root.id}: work they asked for and plans you settled together. Do not start what they have not agreed to; suggest it in its Goal instead. When something only the user can decide blocks you, such as a choice they would care about or a step that is irreversible or leaves this workspace, ask it in a Letter (a reply with --ask) and carry on with the rest.`,
  3:root=>`Root Goal #${root.id} is delegated to you: its success criteria are fixed, and how to reach them is your call. The user will not follow each step or review as you go, so do not wait for them. Find what is still missing, plan it, split it into SubGoals, choose the order and carry it all out across its tree, writing each decision into its Goal so the user can catch up later. Ask in a Letter for what is the user's alone: changing the success criteria, matters of taste the criteria leave open, and anything irreversible or beyond this workspace, such as merging to a shared branch, deleting data or publishing. Meanwhile keep working on the rest of the tree.`
    +`${root.open.length?`\n  Unfinished in that tree: ${some(root.open)}.`:''}${root.taken.length?`\n  Taken by other live conversations, so leave them: ${some(root.taken)}.`:''}`,
};
// The Roots listed by level name with what each asks, so the message stands on its own.
export function autonomyLines(plan) {
  return plan.roots.map(root=>`- Root Goal #${root.id} ${quote(root.title)}, ${name(root.level)}: ${meaning[root.level](root)}`).join('\n');
}

// What every harness reads for its end-of-turn check. `owner` is the
// conversation whose Roots it reads, `held` (when a Root is at Ultra Continue) the Goals other
// live conversations hold (agents goalsHeldElsewhere). The revision is the one
// the check's facts carry (continuation-workspace ownedWorkspace): the Roots
// the plan lists, their levels included, so a level change is a new revision.
export async function readTurnPlan({owner,held=async()=>new Set()}) {
  const goals=await listGoals(),levels=await ownedRootLevels(owner,goals);
  let plan=turnPlan({goals,levels});
  if(plan?.roots.some(root=>root.level===ultra))plan=turnPlan({goals,levels,held:await held()});
  if(!plan)return null;
  return {...plan,revision:(await ownedWorkspace(owner)).revision};
}
