import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { saveMessageSetting } from '../lib/message-settings.mjs';
import {fileURLToPath} from 'node:url';
import {expectHidden} from './hidden-failures.mjs';
import {sentTo,usedChat} from './fake-codex-desktop.mjs';
// These cases cover the host's own notification path, used when bundled extensions are off.
process.env.CHILL_AGENT_EXTENSIONS='none';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/chill-agent.mjs',import.meta.url));
const thread = '00000000-0000-0000-0000-000000000001';
const other = '00000000-0000-0000-0000-000000000002';
const fake = fileURLToPath(new URL('./fake-codex.mjs',import.meta.url));
const hook = fileURLToPath(new URL('../bin/chill-hook.mjs',import.meta.url));
const turn = '00000000-0000-0000-0000-000000000010';
function runHook(f, input = {}, extra = {}) {
  const child = spawn(process.execPath, [hook], {env:{...f.env,...extra},stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.on('data',chunk=>{stdout+=chunk;}); child.stderr.on('data',chunk=>{stderr+=chunk;});
  child.stdin.end(JSON.stringify({hook_event_name:'PostToolUse',session_id:thread,turn_id:turn,...input}));
  return new Promise((resolve,reject)=>{
    child.on('error',reject);
    child.on('close',code=>code===0?resolve({stdout,stderr}):reject(new Error(stderr)));
  });
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'chill-delivery-test-'));
  await usedChat(root);
  const env = { ...process.env, CHILL_AGENT_DATA_DIR: root, CHILL_AGENT_CODEX_PATH: fake, CODEX_THREAD_ID: thread };
  const run = (args, extra = {}) => execute(process.execPath, [cli, ...args], { env: { ...env, ...extra } });
  const json = async path => JSON.parse(await readFile(join(root, path), 'utf8'));
  const assign=chat=>chat?run(['adopt','--id','1'],{CODEX_THREAD_ID:chat}):run(['release','--id','1']);
  const body = join(root, 'workspace/goals/1/deliverable.md');
  await run(['create', '--title', 'Delivery']);
  let updates=0;
  const publish = async (chat = thread) => {await assign(chat);await writeFile(body,`通知テスト ${++updates}`);return run(['deliverable','update','--id','1']);};
  await publish();
  const select=async(goalId='1',turnId=turn,chatId=thread,stoppedAt=null)=>{
    await mkdir(join(root,'workspace/executions'),{recursive:true});
    await writeFile(join(root,'workspace/executions',`${chatId}.json`),JSON.stringify({goalId,threadId:chatId,turnId,stoppedAt,heartbeatAt:new Date().toISOString()}));
  };
  await select();
  const feedback = async (input = {}, extra = {}) => {
    const path = join(root, 'input.json');
    await writeFile(path, JSON.stringify({text:'続けてください',...input}));
    const { stdout } = await run(['feedback','--id','1','--input-file',path],extra);
    return stdout.trim().split('\n').map(line=>JSON.parse(line));
  };
  return {root,env,run,json,body,publish,feedback,assign,select};
}

test('root chat owns Goal conversation before and after Deliverable edits',async t=>{
  if(process.platform==='win32')expectHidden(t,'codex-work.observe');
  const f=await fixture();await f.publish();
  const [{feedback},{comment}]=await f.feedback();
  assert.equal(comment.mark,process.platform==='win32'?'saved':'handed','on Windows the fake Codex cannot run, so the comment stays saved');
  assert.equal(feedback.version,undefined);
  await assert.rejects(f.feedback({version:1}),/Unknown Conversation field/);
  await assert.rejects(f.feedback({threadId:other}),/Unknown Conversation field/);
});
test('a released Root saves comments locally without enqueueing',async()=>{
  const f=await fixture();await f.assign(null);
  const [,{comment}]=await f.feedback();assert.equal(comment.mark,'saved');assert.equal(comment.unassigned,true);
  await assert.rejects(readFile(join(f.root,'fake-queue.json')),{code:'ENOENT'});
});

test('installing the hook is idempotent and preserves other hooks without modifying trust', async () => {
  const f=await fixture();const path=join(f.root,'.codex','hooks.json');
  await mkdir(join(f.root,'.codex'));
  const existing={description:'Keep me',hooks:{PostToolUse:[{matcher:'Bash',hooks:[{type:'command',command:'echo existing'}]}]}};
  await writeFile(path,JSON.stringify(existing));
  for(let i=0;i<2;i++)await execute(process.execPath,[hook,'--install'],{cwd:f.root,env:f.env});
  const installed=JSON.parse(await readFile(path,'utf8'));
  assert.equal(installed.description,existing.description);
  assert.deepEqual(installed.hooks.PostToolUse[0],existing.hooks.PostToolUse[0]);
  assert.equal(installed.hooks.PostToolUse.length,2);
  assert.equal(installed.hooks.PostToolUse[1].matcher,'*');
  const ownHook=installed.hooks.PostToolUse[1].hooks[0];
  assert.equal(ownHook.statusMessage,'chill-agent: Check Web feedback');
  assert.deepEqual(installed.hooks.Stop,[{hooks:[{type:'command',command:ownHook.command,statusMessage:'chill-agent: Check the user has heard back',timeout:15}]}]);
  // Upgrade a pre-label definition in place, keeping user settings and other hooks.
  delete ownHook.statusMessage;
  ownHook.timeout=25;
  await writeFile(path,JSON.stringify(installed));
  await execute(process.execPath,[hook,'--install'],{cwd:f.root,env:f.env});
  ownHook.statusMessage='chill-agent: Check Web feedback';
  assert.deepEqual(JSON.parse(await readFile(path,'utf8')),installed);
  const upgraded=await readFile(path,'utf8');
  await execute(process.execPath,[hook,'--install'],{cwd:f.root,env:f.env});
  assert.equal(await readFile(path,'utf8'),upgraded);
  await assert.rejects(readFile(join(f.root,'.codex','config.toml')),{code:'ENOENT'});
});



test('saved notification preferences reach a new chat in its message, and are read again when it notifies', {skip:process.platform==='win32'&&'Codex Desktop harness is macOS-only; fake-codex.mjs runs as an executable'},async () => {
  const f = await fixture();
  await saveMessageSetting('notifications', {enabled:true,tool:'chosen-tool',destination:'chosen-recipient',on:['comment','letter']}, f.root);
  assert.equal((await runHook(f)).stdout, '', 'a notification setting alone does not make every tool call noisy');
  await f.publish(other);
  const [, {comment}] = await f.feedback({});
  assert.equal(comment.mark, 'handed');
  const queued = (await sentTo(f.root, thread))[0];
  assert.match(queued, /notice --id 1 --event <saved-event-id>/);
  assert.equal((await runHook(f,{session_id:other},{CODEX_THREAD_ID:other})).stdout, '', 'nothing is handed twice');
  // A message can outlive the settings that created it. Its command re-reads
  // current preferences instead of freezing a recipient in the chat.
  await saveMessageSetting('notifications', {enabled:true,tool:'changed-tool',destination:'new-recipient',on:['comment']}, f.root);
  const settingsCLI = fileURLToPath(new URL('../bin/chill-settings.mjs',import.meta.url));
  await f.run(['reply','--id','1','--text','Finished'],{CODEX_THREAD_ID:other});
  const noticeArgs = ['notice','--id','1','--event','2'];
  const current = JSON.parse((await execute(process.execPath,[settingsCLI,...noticeArgs],{env:f.env})).stdout);
  assert.equal(current.destination, 'new-recipient');
  assert.equal(current.tool, 'changed-tool');
  await saveMessageSetting('notifications', {enabled:false}, f.root);
  assert.deepEqual(JSON.parse((await execute(process.execPath,[settingsCLI,...noticeArgs],{env:f.env})).stdout), {enabled:false});
});

test('invalid optional notification settings do not block publishing or receiving feedback', {skip:process.platform==='win32'&&'Codex Desktop harness is macOS-only; fake-codex.mjs runs as an executable'},async () => {
  const f = await fixture();
  await mkdir(join(f.root,'settings'));
  await writeFile(join(f.root,'settings/notifications.json'), '{broken');
  const applied = await f.publish();
  assert.equal(JSON.parse(applied.stdout).version,2);
  const [, {comment}] = await f.feedback({});
  assert.equal(comment.mark, 'handed');
  const queued = (await sentTo(f.root, thread))[0];
  assert.match(queued, /"eventId":1,/);
  assert.match(queued, /Could not read saved user notification preferences/);
});
