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

scenario('feedback saved while the agent is idle reaches it and shows as running',async (s,driver)=>{
  const event=await s.saveFeedback('Please start');
  assert.equal(await s.shown(event),driver.pending,'before the agent reads it');
  assert.deepEqual(await s.agentTakesFeedback(event),[event]);
  assert.equal(await s.shown(event),'working');
});

scenario('feedback saved while the agent responds shows Waiting and reaches it when the response ends',async s=>{
  await s.agentStartsResponse();
  const event=await s.saveFeedback('After this');
  assert.equal(await s.shown(event),'waiting');
  assert.deepEqual(await s.agentTakesFeedback(event),[],'a running response is not interrupted');
  assert.equal(await s.shown(event),'waiting');
  await s.agentEndsResponse();
  assert.deepEqual(await s.agentTakesFeedback(event),[event]);
  assert.equal(await s.shown(event),'working');
});

scenario('Send now delivers feedback that waits for the running response',async (s,driver)=>{
  await s.agentStartsResponse();
  const event=await s.saveFeedback('Right now');
  assert.equal(await s.shown(event),'waiting');
  await s.sendNow(event);
  assert.equal(await s.shown(event),driver.pending);
  assert.deepEqual(await s.agentTakesFeedback(event),[event]);
  assert.equal(await s.shown(event),'working');
});

scenario('the agent\'s reply completes the feedback once the response ends',async s=>{
  const event=await s.saveFeedback('Question');
  await s.agentTakesFeedback(event);
  await s.agentReplies(event,'Answer');
  assert.equal(await s.receipt(event),'completed');
  assert.deepEqual(await s.comments(),['Answer']);
  await s.agentEndsResponse();
  assert.equal(await s.shown(event),'completed');
});

scenario('a completed receipt without a reply closes the feedback',async s=>{
  const event=await s.saveFeedback('Just do it');
  await s.agentTakesFeedback(event);
  await s.agentReports(event,'completed');
  assert.equal(await s.receipt(event),'completed');
  await s.agentEndsResponse();
  assert.equal(await s.shown(event),'completed');
  assert.deepEqual(await s.comments(),[]);
});

scenario('the agent cannot report feedback as failed',async s=>{
  const event=await s.saveFeedback('Try it');
  await s.agentTakesFeedback(event);
  await assert.rejects(s.agentReports(event,'failed'),/--state must be/);
  assert.equal(await s.receipt(event),'working');
  await s.agentEndsResponse();
  assert.notEqual(await s.shown(event),'failed');
});

scenario('a retry does not deliver the feedback twice',async s=>{
  const event=await s.saveFeedback('Once');
  await s.retry(event);
  assert.deepEqual(await s.agentTakesFeedback(event),[event]);
  await s.retry(event);
  assert.deepEqual(await s.agentTakesFeedback(event),[],'already taken');
});

scenario('another conversation cannot report on the feedback',async (s,driver) => {
  const event=await s.saveFeedback('Mine');
  await assert.rejects(s.strangerReports(event),/assigned chat|another conversation/);
  assert.equal(await s.shown(event),driver.pending);
  assert.deepEqual(await s.agentTakesFeedback(event),[event]);
});

scenario('the Goal shows Running with an Activity row while the agent works on its feedback, and neither after',async s=>{
  const event=await s.saveFeedback('Work');
  await s.agentTakesFeedback(event);
  assert.equal(await s.goalRunning(),true);
  const row=await s.activityRow();
  assert.equal(row.eventId,event);assert.equal(row.status,'working');
  await s.agentReplies(event,'Done');
  await s.agentEndsResponse();
  assert.equal(await s.goalRunning(),false);
  assert.notEqual((await s.activityRow())?.status,'working');
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

scenario('a deferred receipt works where the harness has a native Queue, and says so where it does not',async (s,driver) => {
  await s.agentStartsResponse();
  const event=await s.saveFeedback('Later');
  const result=await s.agentDefers(event);
  if(driver.capabilities.deferredReceipts) {
    assert.equal(result.deferred,true);
    assert.equal(await s.receipt(event),'deferred');
  } else {
    assert.match(result.unsupported,/native Queue/);
    assert.equal(await s.shown(event),'waiting');
  }
});

scenario('Approve all is offered where the harness supports it, and refused where it does not',async (s,driver) => {
  assert.equal((await s.agentStatus()).capabilities.approveAll,driver.capabilities.approveAll);
  if(driver.capabilities.approveAll) {
    assert.equal((await s.approveAll(true)).approveAll,true);
    assert.equal((await s.approveAll(false)).approveAll,false);
  } else await assert.rejects(s.approveAll(true),/not available/);
});

scenario('Pause holds unread feedback and Resume releases it where the harness can pause, and is refused where it cannot',async (s,driver) => {
  const event=await s.saveFeedback('Hold this');
  assert.equal((await s.activityRow())?.capabilities.stop??false,driver.capabilities.pause);
  if(driver.capabilities.pause) {
    assert.equal((await s.pauseRow('stop')).status,'paused');
    assert.equal(await s.shown(event),'paused');
    assert.equal((await s.pauseRow('resume')).status,'saved');
    assert.equal(await s.shown(event),'saved');
    assert.deepEqual(await s.agentTakesFeedback(event),[event]);
  } else await assert.rejects(s.pauseRow('stop'),/Status changed/);
});

scenario('a stop with nothing running and nothing said about feedback the agent took is held once, to tell the user',async (s,driver) => {
  const event=await s.saveFeedback('Fix the build');
  await s.agentTakesFeedback(event);
  const hold=await s.agentEndsResponse();
  assert.match(hold??'',new RegExp(`#${event} \\(Goal #${s.goalId}\\)`),'the user has heard nothing since the feedback');
  assert.equal(await s.agentEndsResponse(),null,'the stop right after a hold ends');
  await s.agentStartsResponse();
  assert.match(await s.agentEndsResponse()??'',/Nothing has reached them/,'a later stop with still nothing said is held again');
  assert.equal(await s.agentEndsResponse(),null);
  await s.agentStartsResponse();
  await s.agentComments('Waiting for CI; I will check again in 10 minutes.');
  assert.equal(await s.agentEndsResponse(),null,'a progress comment since the last stop');
  await s.agentStartsResponse();
  const background=await s.agentEndsResponse({background:true});
  if(driver.capabilities.backgroundWork)assert.equal(background,null,'background work wakes the agent later');
  else {assert.match(background??'',/Nothing has reached them/,'the harness reports no background work');await s.agentEndsResponse();}
  await s.agentStartsResponse();
  await s.agentReplies(event,'Fixed');
  assert.equal(await s.agentEndsResponse(),null,'the reply completes the feedback');
  assert.equal(await s.receipt(event),'completed');
});
