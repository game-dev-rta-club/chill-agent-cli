// What a user sees and does, written once and run against every agent harness (test/harness-drivers.mjs).
// A new user-visible flow is not done until it has a scenario here, or the harness that lacks it declares
// the gap in `capabilities` and the scenario asserts the interface says so. Per-harness tests keep covering
// protocol detail; this file is what makes a change to shared code fail for the harness it breaks.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {drivers} from './harness-drivers.mjs';

const names=new Set();
// A driver's `todo` maps a scenario to the reason it fails there; the failure is reported without failing the run.
const scenario=(name,run)=>{
  names.add(name);
  for(const driver of drivers)test(`${name} [${driver.name}]`,{skip:driver.skip,todo:driver.todo?.[name]},async t=>run(await driver.start(t),driver));
};
after(()=>{
  for(const driver of drivers)for(const name of Object.keys(driver.todo??{}))assert.ok(names.has(name),`${driver.name} lists a todo for a scenario that does not exist: ${name}`);
});

// Under a comment the Goal shows only where it is, until the agent replies (agent-rules commentMark).
scenario('feedback saved while the agent is idle reaches it, and the Goal shows the agent Running on it',async (s,driver)=>{
  const event=await s.saveFeedback('Please start');
  assert.equal(await s.shown(event),driver.pending,'before the agent reads it');
  assert.deepEqual(await s.agentTakesFeedback(event),[event]);
  assert.equal(await s.shown(event),'handed');
  assert.equal((await s.activity()).state,'running');
});

scenario('feedback saved while the agent responds shows Waiting and reaches it when the response ends',async s=>{
  await s.agentStartsResponse();
  const event=await s.saveFeedback('After this');
  assert.equal(await s.shown(event),'waiting');
  assert.deepEqual(await s.agentTakesFeedback(event),[],'a running response is not interrupted');
  assert.equal(await s.shown(event),'waiting');
  await s.agentEndsResponse();
  assert.deepEqual(await s.agentTakesFeedback(event),[event]);
  assert.equal(await s.shown(event),'handed');
});

scenario('Send now delivers feedback that waits for the running response',async s=>{
  await s.agentStartsResponse();
  const event=await s.saveFeedback('Right now');
  assert.equal(await s.shown(event),'waiting');
  await s.sendNow(event);
  assert.equal(await s.shown(event),'saved','no longer Waiting; the running work receives it at its next chance');
  assert.deepEqual(await s.agentTakesFeedback(event),[event]);
  assert.equal(await s.shown(event),'handed');
});

// A Goal is answered by the agent's Comment on it, whichever comment it answers (agent-rules).
scenario('the agent\'s reply clears the marks at once, while its work still runs',async s=>{
  const first=await s.saveFeedback('Question');
  await s.agentTakesFeedback(first);
  await s.agentReplies(first,'Answer');
  assert.equal(await s.shown(first),null);
  assert.deepEqual(await s.comments(),['Answer']);
  await s.agentEndsResponse();
  assert.equal(await s.shown(first),null);
});

scenario('the end of the work without a reply leaves the comment marked, awaiting one',async s=>{
  const event=await s.saveFeedback('Just do it');
  await s.agentTakesFeedback(event);
  await s.agentEndsResponse();
  assert.equal(await s.shown(event),'handed','only a reply answers the user');
  assert.deepEqual(await s.comments(),[]);
});

scenario('a comment reaches the agent once, and a later comment brings only itself',async s=>{
  const event=await s.saveFeedback('Once');
  assert.deepEqual(await s.agentTakesFeedback(event),[event]);
  assert.deepEqual(await s.agentTakesFeedback(event),[],'already taken');
  await s.agentEndsResponse();await s.agentEndsResponse();
  const next=await s.saveFeedback('And this');
  assert.deepEqual(await s.agentTakesFeedback(next),[next]);
});

scenario('another conversation cannot answer the feedback',async (s,driver) => {
  const event=await s.saveFeedback('Mine');
  await assert.rejects(s.strangerAnswers(event),/assigned chat|another conversation/);
  assert.equal(await s.shown(event),driver.pending);
  assert.deepEqual(await s.agentTakesFeedback(event),[event]);
});

scenario('the Goal shows Running and Think while the agent works on its feedback, and neither after',async s=>{
  const event=await s.saveFeedback('Work');
  await s.agentTakesFeedback(event);
  assert.equal(await s.goalRunning(),true);
  const activity=await s.activity();
  assert.equal(activity.state,'running');assert.equal(activity.live,true);
  await s.agentReplies(event,'Done');
  await s.agentEndsResponse();
  assert.equal(await s.goalRunning(),false);
  assert.notEqual((await s.activity())?.state,'running');
});

scenario('goal work marks the Goal Running for the response that selected it',async s=>{
  await s.agentStartsResponse();
  await s.agentSelectsWork();
  assert.equal(await s.goalRunning(),true);
  await s.agentEndsResponse();
  assert.equal(await s.goalRunning(),false);
});

scenario('the Agent menu reads the agent\'s name, model and status',async (s,driver) => {
  const idle=await s.agentStatus();
  assert.equal(idle.connected,true);
  assert.equal(idle.agent.name,driver.agentName);
  await s.agentStartsResponse();
  assert.equal((await s.agentStatus()).work.status,'working');
  await s.agentEndsResponse();
  const done=await s.agentStatus();
  assert.equal(done.work.status,'idle');
  assert.ok(done.agent.model.model,'the model it answered with');
});

// Autonomy (public/autonomy.js) is the Goal's own level; the agent meets it at its next hook.
scenario('Autonomy reaches the agent: feedback at 2 asks it to think in the user\'s place, and tool prompts are approved at 3 where a hook can answer them',async (s,driver) => {
  await s.setAutonomy(2);
  const event=await s.saveFeedback('Choose the safer migration');
  assert.deepEqual(await s.agentTakesFeedback(event),[event]);
  assert.match(s.feedbackText(),/Autonomy Lv 2 Thorough on Goal #\d+: Think in the user's place\. Prefer accuracy to speed/);
  if(driver.capabilities.approvals) {
    assert.equal(await s.permissionPrompt(),null,'Thorough still asks');
    await s.setAutonomy(3);
    assert.equal(await s.permissionPrompt(),'allow','Continue approves');
  } else {
    assert.equal(s.permissionPrompt,undefined,'the harness has no prompt a hook can answer');
  }
});

// Pause is the user's (R17); a stop in the agent's own app is Interrupted (R17b). Both show the same on the agent and the comments.
scenario('Pause holds the agent until a new comment resumes it where the harness can pause, and is refused where it cannot',async (s,driver) => {
  const first=await s.saveFeedback('Start');
  await s.agentTakesFeedback(first);
  assert.equal((await s.activity()).capabilities.stop,driver.capabilities.pause);
  if(driver.capabilities.pause) {
    await s.pauseActivity('stop');
    assert.equal((await s.activity()).state,'paused');assert.equal(await s.shown(first),'paused');
    // The user's next comment resumes the agent, so it is handed without Resume.
    const next=await s.saveFeedback('Go on with this');
    assert.notEqual((await s.activity()).state,'paused');
    assert.notEqual(await s.shown(next),'paused');
    await s.agentEndsResponse();
    assert.deepEqual(await s.agentTakesFeedback(next),[next]);
  } else await assert.rejects(s.pauseActivity('stop'),/Status changed/);
});

scenario('a stop in the agent\'s own app shows Interrupted, not Paused, and the next feedback starts it again',async (s,driver) => {
  const event=await s.saveFeedback('Start');
  await s.agentTakesFeedback(event);
  await s.agentIsInterrupted();
  assert.equal((await s.activity()).state,'interrupted');
  assert.equal(await s.shown(event),'interrupted');
  assert.equal(await s.goalRunning(),false);
  const next=await s.saveFeedback('Go on');
  assert.equal(await s.shown(next),driver.pending,'an interrupted agent is handed feedback at once');
  assert.deepEqual(await s.agentTakesFeedback(next),[next]);
  assert.equal((await s.activity()).state,'running');
});

// Running comes only from the harness's start and end of work, never from what is written to the conversation.
scenario('a command the user runs in the agent\'s own app, such as /reload-skills, does not make it Running',async (s,driver)=>{
  await s.userRunsLocalCommand();
  assert.equal((await s.agentStatus()).work.status,'idle');
  assert.equal(await s.goalRunning(),false);
  const event=await s.saveFeedback('Now');
  assert.equal(await s.shown(event),driver.pending,'not held as Waiting');
});

scenario('a stop with nothing running and nothing said about feedback the agent took is held once, to tell the user',async (s,driver) => {
  const event=await s.saveFeedback('Fix the build');
  await s.agentTakesFeedback(event);
  const hold=await s.agentEndsResponse();
  assert.match(hold??'',/tell the user where things stand/,'the user has heard nothing since the feedback');
  assert.match(hold,new RegExp(`Goal #${s.goalId}\\b`));
  assert.deepEqual(await s.comments(),[],'what the agent wrote is not posted for it');
  assert.equal(await s.agentEndsResponse(),null,'the stop right after a hold ends');
  await s.agentStartsResponse();
  assert.match(await s.agentEndsResponse()??'',/where things stand/,'a later stop with still nothing said is held again');
  assert.equal(await s.agentEndsResponse(),null);
  await s.agentStartsResponse();
  await s.agentComments('Waiting for CI; I will check again in 10 minutes.');
  assert.equal(await s.agentEndsResponse(),null,'a progress comment answers the Goal');
  const more=await s.saveFeedback('Also update the docs');
  await s.agentTakesFeedback(more);
  const background=await s.agentEndsResponse({background:true});
  if(driver.capabilities.backgroundWork)assert.equal(background,null,'background work wakes the agent later');
  else {assert.match(background??'',/where things stand/,'the harness reports no background work');await s.agentEndsResponse();}
  await s.agentStartsResponse();
  await s.agentReplies(more,'Fixed');
  assert.equal(await s.agentEndsResponse(),null,'the reply answers the Goal');
  assert.equal(await s.shown(event),null);assert.equal(await s.shown(more),null);
});
