// Reusable fixtures for a human-supervised fresh-agent Skill trial.
// The tested CLI/server are real; only Codex transport is a local fake.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildPlugins } from '../scripts/build-plugins.mjs';
import { readFeedback, readBrief, listStoredGoals } from '../lib/goal-store.mjs';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));
const [action, givenRoot] = process.argv.slice(2);
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port=server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function fixture(root) {
  const state=JSON.parse(await readFile(join(root,'fixture.json'),'utf8'));
  assert.equal(state.kind,'chill-agent-skill-smoke');
  assert.equal(state.root,resolve(root));
  return state;
}
function environment(f) {
  return {...process.env,CHILL_AGENT_DATA_DIR:f.data,CHILL_AGENT_CODEX_PATH:f.fake,
    CODEX_THREAD_ID:f.thread,PORT:String(f.port),CHILL_AGENT_IDLE_TIMEOUT:'10m'};
}
async function main() {
  if(action==='prepare') {
    const root=await mkdtemp(join(tmpdir(),'chill-skill-smoke-'));
    const f={kind:'chill-agent-skill-smoke',root,project:join(root,'project'),data:join(root,'data'),
      fake:join(root,'fake-codex.mjs'),thread:randomUUID(),port:await freePort()};
    await mkdir(f.project);
    await cp(join(repository,'test/fake-codex.mjs'),f.fake); await chmod(f.fake,0o700);
    await buildPlugins(join(root,'plugins'));
    await writeFile(join(root,'fixture.json'),JSON.stringify(f,null,2));
    const runner=`import {spawn} from 'node:child_process';\nconst f=${JSON.stringify(f)};\nconst [command,...args]=process.argv.slice(2);\nif(!command)throw new Error('Pass a command to run in the trial environment.');\nconst child=spawn(command,args,{cwd:f.project,stdio:'inherit',env:{...process.env,CHILL_AGENT_DATA_DIR:f.data,CHILL_AGENT_CODEX_PATH:f.fake,CODEX_THREAD_ID:f.thread,PORT:String(f.port),CHILL_AGENT_IDLE_TIMEOUT:'10m'}});\nchild.on('error',error=>{console.error(error.message);process.exitCode=1;});\nchild.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});\n`;
    await writeFile(join(root,'run.mjs'),runner);
    await writeFile(join(root,'ENVIRONMENT.md'),`# Trial environment\n\nWorking directory: ${f.project}\nCore Skill: ${root}/plugins/codex/chill-agent/skills/chill-agent/SKILL.md\nSetup Skill: ${root}/plugins/codex/chill-agent-message-setup/skills/chill-agent-message-setup/SKILL.md\n\nRun every shell/CLI operation through:\n\nnode '${root}/run.mjs' <command> <arguments...>\n\nThis sets the isolated data directory, project, port, and test chat ID. Read files directly if useful; all writes must stay under ${root}. The real CLI and server run here; only Codex transport is fake, so no production chat receives messages. Do not open the app browser, modify global configuration, install software, publish a tunnel, or send external messages. Provide a URL when needed. Use only this fixture, its packaged Skills/help, and your general knowledge; do not inspect the development repository, other Goal data, or the evaluator's files. Leave created files and server available for inspection; report any obstacles without editing the packaged Skill/runtime.\n`);
    console.log(JSON.stringify(f,null,2)); return;
  }
  if(!givenRoot)throw new Error('Usage: node test/skill-smoke.mjs prepare | <next-step|verify|cleanup> <fixture-root>');
  const f=await fixture(givenRoot), env=environment(f);
  process.env.CHILL_AGENT_DATA_DIR=f.data;
  const cli=join(f.root,'plugins/codex/chill-agent/bin/chill-agent.mjs');
  if(action==='next-step') {
    const plans=await listStoredGoals(); assert.equal(plans.length,1,'the planning run should create one Goal');
    const plan=(await readFeedback()).findLast(e=>e.type==='letter'&&e.goalId===plans[0].id); assert.ok(plan);
    const input={annotations:[{kind:'letter',source:{kind:'comment',eventId:plan.id},text:'この方針で進めてください。'}],text:'この方針で、小さく実装して結果を教えて。残りh、開始・Pause・リセットがあれば十分です。通知音や履歴は今回は不要です。',requestId:'skill-smoke-next-step'};
    const inputFile=join(f.root,'feedback.json');await writeFile(inputFile,JSON.stringify(input));
    const {stdout}=await execute(process.execPath,[cli,'feedback','--id',plan.goalId,'--input-file',inputFile],{env});
    const feedback=JSON.parse(stdout.split('\n')[0]).feedback;
    await writeFile(join(f.root,'acceptance.json'),JSON.stringify({goalId:plan.goalId,letterId:plan.id,eventId:feedback.changeId},null,2));
    console.log(JSON.stringify({goalId:plan.goalId,letterId:plan.id,eventId:feedback.changeId},null,2));return;
  }
  if(action==='verify') {
    const plans=await listStoredGoals();assert.equal(plans.length,1);
    const plan=await readBrief(plans[0].id);assert.ok(plan?.body);
    const accepted=JSON.parse(await readFile(join(f.root,'acceptance.json'),'utf8'));
    const delivery=JSON.parse(await readFile(join(f.data,'workspace','deliveries',`${accepted.eventId}.json`),'utf8'));
    assert.equal(delivery.status,'completed');assert.ok(!delivery.queueError);
    const events=await readFeedback();assert.equal(events.filter(e=>e.author==='user').length,1);
    const queue=JSON.parse(await readFile(join(f.data,'fake-queue.json'),'utf8'));assert.equal(queue.length,0);
    assert.ok(events.some(e=>e.type==='letter'&&e.goalId===plan.goalId));
    assert.ok(events.some(e=>e.type==='comment'&&e.author==='agent'&&e.goalId===plan.goalId));
    const files=await readdir(f.project);
    let settings=[];try{settings=await readdir(join(f.data,'settings'));}catch(error){if(error.code!=='ENOENT')throw error;}
    assert.equal(settings.length,0,'the core trial must not configure external connections');
    console.log(JSON.stringify({goalId:plan.goalId,briefVersion:plan.version,feedback:delivery.status,queueRemaining:queue.length,projectFiles:files},null,2));return;
  }
  if(action==='cleanup') {
    // Stop only this fixture's launchd label. Preserve evidence until the operator removes it.
    const server=join(f.root,'plugins/codex/chill-agent/bin/chill-server.mjs');
    console.log((await execute(process.execPath,[server,'stop'],{env})).stdout.trim());return;
  }
  throw new Error('Unknown trial action.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
