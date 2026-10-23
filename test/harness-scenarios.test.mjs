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
  await s.agentEndsResponse({text:null});
  assert.equal(await s.shown(event),'handed','only a reply answers the user');
  assert.deepEqual(await s.comments(),[]);
});

// The final reply of the work is the answer when one Goal awaits it (hand-off postFinalReply).
scenario('the final reply of the work answers the Goal awaiting it, once',async s=>{
  const event=await s.saveFeedback('Fix the typo');
  await s.agentTakesFeedback(event);
  assert.equal(await s.agentEndsResponse({text:'Fixed the typo in the README.'}),null,'answered, so the stop is not held');
  assert.equal(await s.shown(event),null);
  assert.deepEqual(await s.comments(),['Fixed the typo in the README.']);
  await s.agentStartsResponse();
  assert.equal(await s.agentEndsResponse({text:'Nothing else to do.'}),null);
  assert.deepEqual(await s.comments(),['Fixed the typo in the README.'],'with nothing awaiting a reply, the final reply stays in the conversation');
});

// Only feedback handed during the work takes its final reply (hand-off postFinalReply).
scenario('feedback handed at the end of the work is answered by the final reply that follows it',async s=>{
  await s.agentStartsResponse();
  const event=await s.saveFeedback('One more thing');
  assert.match(await s.agentEndsResponse({text:'Working.'}),/One more thing/,'handed at the stop; the work goes on');
  assert.deepEqual(await s.comments(),[]);
  assert.equal(await s.agentEndsResponse({text:'Did the one more thing.'}),null);
  assert.equal(await s.shown(event),null);
  assert.deepEqual(await s.comments(),['Did the one more thing.']);
});

scenario('feedback left awaiting by stopped work gets no later final reply; the stop asks for a reply',async s=>{
  const event=await s.saveFeedback('Fix the typo');
  await s.agentTakesFeedback(event);
  await s.agentIsInterrupted();
  await s.agentStartsResponse();
  assert.match(await s.agentEndsResponse({text:'CI is green; nothing left.'}),new RegExp(`Goal #${s.goalId}\\b`));
  assert.equal(await s.agentEndsResponse({text:'CI is green; nothing left.'}),null);
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

scenario('Approve all is offered where the harness supports it, and refused where it does not',async (s,driver) => {
  assert.equal((await s.agentStatus()).capabilities.approveAll,driver.capabilities.approveAll);
  if(driver.capabilities.approveAll) {
    assert.equal((await s.approveAll(true)).approveAll,true);
    assert.equal((await s.approveAll(false)).approveAll,false);
  } else await assert.rejects(s.approveAll(true),/not available/);
});

// Pause is the user's (R17); a stop in the agent's own app is Interrupted (R17b). Both show the same on the agent and the comments.
scenario('Pause holds new feedback and Resume releases it where the harness can pause, and is refused where it cannot',async (s,driver) => {
  const first=await s.saveFeedback('Start');
  await s.agentTakesFeedback(first);
  assert.equal((await s.activity()).capabilities.stop,driver.capabilities.pause);
  if(driver.capabilities.pause) {
    await s.pauseActivity('stop');
    assert.equal((await s.activity()).state,'paused');
    const held=await s.saveFeedback('Hold this');
    assert.equal(await s.shown(held),'paused');assert.equal(await s.shown(first),'paused');
    assert.deepEqual(await s.agentTakesFeedback(held),[],'nothing is handed while paused');
    await s.pauseActivity('resume');
    assert.notEqual(await s.shown(held),'paused');
    // Without a final reply, the response goes on to take what was held.
    await s.agentEndsResponse({text:null});
    assert.deepEqual(await s.agentTakesFeedback(held),[held]);
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
  const hold=await s.agentEndsResponse({text:null});
  assert.match(hold??'',/tell the user where things stand/,'the user has heard nothing since the feedback');
  assert.match(hold,new RegExp(`Goal #${s.goalId}\\b`));
  assert.equal(await s.agentEndsResponse({text:null}),null,'the stop right after a hold ends');
  await s.agentStartsResponse();
  assert.match(await s.agentEndsResponse({text:null})??'',/where things stand/,'a later stop with still nothing said is held again');
  assert.equal(await s.agentEndsResponse({text:null}),null);
  await s.agentStartsResponse();
  await s.agentComments('Waiting for CI; I will check again in 10 minutes.');
  assert.equal(await s.agentEndsResponse({text:null}),null,'a progress comment answers the Goal');
  const more=await s.saveFeedback('Also update the docs');
  await s.agentTakesFeedback(more);
  const background=await s.agentEndsResponse({background:true,text:null});
  if(driver.capabilities.backgroundWork)assert.equal(background,null,'background work wakes the agent later');
  else {assert.match(background??'',/where things stand/,'the harness reports no background work');await s.agentEndsResponse({text:null});}
  await s.agentStartsResponse();
  await s.agentReplies(more,'Fixed');
  assert.equal(await s.agentEndsResponse({text:null}),null,'the reply answers the Goal');
  assert.equal(await s.shown(event),null);assert.equal(await s.shown(more),null);
});
