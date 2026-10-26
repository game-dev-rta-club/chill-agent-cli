// Autonomy (public/autonomy.js) as the agent meets it: a line in the feedback
// text, one message at the end of a turn, and tool approvals. Each harness
// supplies what its conversation recorded; the rules are the same for all.
import {createHash} from 'node:crypto';
import {autonomyLevels,autonomyOf} from '../public/autonomy.js';
import {listGoals,readFeedback} from './goal-store.mjs';
import {continuationWorkspace} from './continuation-workspace.mjs';
export {autonomyLevels,autonomyOf};

const name=level=>autonomyLevels[level-1].name;
// Feedback text, for each handed Goal at 2 or higher.
export const thoroughLine="Think in the user's place. Prefer accuracy to speed: investigate deeply and widely, then give your best answer. Ask only what only the user can decide.";
export function feedbackAutonomy(goals) {
  const shown=goals.filter(goal=>autonomyOf(goal)>=2);
  if(!shown.length)return '';
  return `Autonomy ${shown.map(goal=>`Lv ${autonomyOf(goal)} ${name(autonomyOf(goal))} on Goal #${goal.id}`).join(', ')}: ${thoroughLine}`;
}

const rootIn=byId=>goal=>{const seen=new Set();while(goal?.parentId&&!seen.has(goal.id)){seen.add(goal.id);goal=byId.get(goal.parentId);}return goal;};
// The conversation's Goals: the unfinished Goals, in the Roots it owns, that
// its current work was handed comments on, that it last worked in, or that it
// selected with goal work (`recent`). When none of them is unfinished, each
// owned Root's focus stands in, as the end-of-turn check always used: the Goal
// with the Root's latest user comment, or the Root itself.
export function conversationGoals({goals,events,owns,recent=[]}) {
  const byId=new Map(goals.map(g=>[g.id,g])),rootOf=rootIn(byId);
  const roots=goals.filter(g=>!g.parentId&&owns(g)).map(g=>g.id);
  const mine=id=>{const goal=byId.get(id);return goal&&goal.state!=='done'&&roots.includes(rootOf(goal)?.id)?goal:null;};
  const pick=ids=>[...new Set(ids.filter(id=>id!=null).map(String))].map(mine).filter(Boolean);
  const found=pick(recent);
  if(found.length||!events)return found;
  return pick(roots.map(rootId=>events.filter(e=>e.author==='user'&&rootOf(byId.get(e.goalId))?.id===rootId).at(-1)?.goalId??rootId));
}
// Tool approvals: allowed when any of the conversation's Goals is at 4, or
// when the lowest among them is at least 3. No Goals, no decision.
export function approvesTools(goals) {
  if(!goals.length)return false;
  const levels=goals.map(autonomyOf);
  return levels.includes(4)||Math.min(...levels)>=3;
}

// The end-of-turn plan for one conversation: its Goals at 2 or higher, the
// highest level among them, and for each Goal at 4 its Root tree, without the
// Goals other live conversations hold. `held(ids)` names those. Null when no
// Goal asks for anything. The revision covers every owned Root, Autonomy
// included, so a level change is a new revision.
export function turnPlan({goals,events,owns,recent,held=new Set()}) {
  const listed=conversationGoals({goals,events,owns,recent}).filter(goal=>autonomyOf(goal)>=2);
  if(!listed.length)return null;
  const byId=new Map(goals.map(g=>[g.id,g])),rootOf=rootIn(byId);
  const level=Math.max(...listed.map(autonomyOf)),top=listed.find(goal=>autonomyOf(goal)===level);
  const brief=goal=>({id:goal.id,title:goal.title});
  const trees=[...new Set(listed.filter(goal=>autonomyOf(goal)===4).map(goal=>rootOf(goal).id))].map(rootId=>{
    const open=goals.filter(goal=>goal.state!=='done'&&rootOf(goal)?.id===rootId);
    return {rootId,title:byId.get(rootId).title,open:open.filter(goal=>!held.has(goal.id)).map(brief),taken:open.filter(goal=>held.has(goal.id)).map(brief)};
  });
  return {level,rootId:rootOf(top).id,goalId:top.id,goalTitle:top.title,goals:listed.map(goal=>({...brief(goal),level:autonomyOf(goal),rootId:rootOf(goal).id})),trees};
}

const quote=title=>`“${String(title||'Goal').slice(0,100)}”`;
const some=(goals,limit=8)=>goals.slice(0,limit).map(goal=>`#${goal.id} ${quote(goal.title)}`).join(', ')+(goals.length>limit?`, and ${goals.length-limit} more`:'');
const meaning={
  2:()=>'Is there anything in this reply you asked or left open that you could have investigated or decided yourself? If so, do it now.',
  3:()=>'After each turn, keep working on what was agreed for this Goal: carry on with the agreed work you can move forward without the user.',
  4:(goal,plan)=>{
    const tree=plan.trees.find(t=>t.rootId===goal.rootId);
    return `Drive the whole project under Root #${goal.rootId}: advance everything in its tree that does not need the user's judgment. Ask the user's decisions as Letters (goal letter) and keep working elsewhere meanwhile.${tree?.open.length?`\n  Unfinished in that tree: ${some(tree.open)}.`:''}${tree?.taken.length?`\n  Taken by other live conversations, so leave them: ${some(tree.taken)}.`:''}`;
  },
};
// The Goals listed with what their level asks, so the message stands on its own.
export function autonomyLines(plan) {
  return plan.goals.map(goal=>`- Goal #${goal.id} ${quote(goal.title)}, Lv ${goal.level} ${name(goal.level)}: ${meaning[goal.level](goal,plan)}`).join('\n');
}

// What every harness reads for its end-of-turn check. `owns` picks the Roots
// of the conversation, `recent` its recorded Goals, `held` (when a Goal is at
// 4) the Goals other live conversations hold (agents goalsHeldElsewhere).
export async function readTurnPlan({owns,recent,held=async()=>new Set()}) {
  const goals=await listGoals(),events=await readFeedback();
  let plan=turnPlan({goals,events,owns,recent});
  if(plan?.trees.length)plan=turnPlan({goals,events,owns,recent,held:await held()});
  if(!plan)return null;
  const roots=goals.filter(g=>!g.parentId&&owns(g)).map(g=>g.id).sort((a,b)=>Number(a)-Number(b));
  const revisions=[];
  for(const rootId of roots)revisions.push((await continuationWorkspace(rootId)).revision);
  return {...plan,revision:createHash('sha256').update(JSON.stringify(revisions)).digest('hex')};
}
