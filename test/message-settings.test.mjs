import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {mkdir,mkdtemp,rm,stat} from 'node:fs/promises';
import {readFile,writeFile} from './record-fixture.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { namedTunnelConfig, readMessageSettings, saveMessageSetting, validateRemote } from '../lib/message-settings.mjs';
import { notificationReminder } from '../lib/notification-reminder.mjs';
import {fileURLToPath} from 'node:url';
// These cases cover the host's own notification path, used when bundled extensions are off.
process.env.CHILL_AGENT_EXTENSIONS='none';

const execute=promisify(execFile);
const remote={mode:'named',url:'https://plans.example.com',tunnelId:'00000000-0000-0000-0000-000000000001',credentialsFile:'/private/cloudflared/credential.json',accessTeam:'test-team',accessAud:['a'.repeat(64)]};
const notifications={enabled:true,tool:'slack-send',destination:'chosen-channel',on:['comment','letter']};

test('settings are optional, private, independently writable, and independently disabled',async t=>{
  const root=await mkdtemp(join(tmpdir(),'chill-settings-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  assert.deepEqual(await readMessageSettings(root),{remote:{mode:'off'},notifications:{enabled:false}});
  await Promise.all([saveMessageSetting('remote',remote,root),saveMessageSetting('notifications',notifications,root)]);
  assert.deepEqual(await readMessageSettings(root),{remote,notifications});
  // Windows has no POSIX permission bits.
  if(process.platform!=='win32')assert.equal((await stat(join(root,'settings/remote.json'))).mode & 0o777,0o600);
  await saveMessageSetting('notifications',{enabled:false},root);
  assert.deepEqual((await readMessageSettings(root)).remote,remote);
  await saveMessageSetting('remote',{mode:'off'},root);
  assert.deepEqual(await readMessageSettings(root),{remote:{mode:'off'},notifications:{...notifications,enabled:false}});
});

test('named tunnel uses exact HTTPS hostname and per-ingress Access verification; invalid settings do not replace good ones',async t=>{
  const root=await mkdtemp(join(tmpdir(),'chill-settings-validation-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  await saveMessageSetting('remote',remote,root);
  for(const patch of [{url:'http://plans.example.com'}, {url:'https://user:password@plans.example.com'}, {url:'https://plans.example.com/path'}, {url:'https://plans.example.com/?token=x'}, {url:'https://plans.trycloudflare.com'}, {accessAud:[]},{accessTeam:''},{credentialsFile:'relative.json'},{token:'secret'}]){
    assert.throws(()=>validateRemote({...remote,...patch}));
    await assert.rejects(saveMessageSetting('remote',{...remote,...patch},root));
  }
  assert.deepEqual((await readMessageSettings(root)).remote,remote);
  const config=namedTunnelConfig(remote,4174);
  assert.equal(config.ingress[0].service,'http://127.0.0.1:4174');
  assert.equal(config.ingress[0].hostname,'plans.example.com');
  assert.deepEqual(config.ingress[0].originRequest.access,{required:true,teamName:'test-team',audTag:['a'.repeat(64)]});
  assert.deepEqual(config.ingress[1],{service:'http_status:404'});
});

test('without the runtime\'s provider there are no notifications: notice and the global switch are refused',async t=>{
  const root=await mkdtemp(join(tmpdir(),'chill-notice-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const env={...process.env,CHILL_AGENT_DATA_DIR:root,PORT:'4173',CHILL_AGENT_CODEX_PATH:fileURLToPath(new URL('./fake-codex.mjs',import.meta.url))};
  const run=(name,args)=>execute(process.execPath,[fileURLToPath(new URL(`../bin/${name}.mjs`,import.meta.url)),...args],{env});
  await run('chill-agent',['create','--title','Saved result']);
  await run('chill-agent',['reply','--id','1','--text','Done']);
  await saveMessageSetting('notifications',notifications,root);
  await assert.rejects(run('chill-settings',['notice','--id','1','--event','1']),/does not provide notifications/);
  await assert.rejects(run('chill-settings',['notifications','--off']),/does not provide notifications/);
});

test('settings access-code prints the panel\'s code only while the public link runs',async t=>{
  const root=await mkdtemp(join(tmpdir(),'chill-access-code-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const env={...process.env,CHILL_AGENT_DATA_DIR:root,PORT:'4173'};
  const run=args=>execute(process.execPath,[fileURLToPath(new URL('../bin/chill-settings.mjs',import.meta.url)),...args],{env});
  await assert.rejects(run(['access-code']),/Public link is not running/);
  await saveMessageSetting('remote',{mode:'quick'},root);
  await mkdir(join(root,'runtime/web-4173'),{recursive:true});
  await writeFile(join(root,'runtime/web-4173/tunnel.json'),JSON.stringify({pid:process.pid,url:'https://quiet-river.trycloudflare.com'}));
  const first=JSON.parse((await run(['access-code'])).stdout);
  assert.match(first.code,/^[0-9]{6}$/);
  assert.equal(first.link,'https://quiet-river.trycloudflare.com/');
  assert.ok(Date.parse(first.expiresAt)>Date.now());
  const saved=JSON.parse(await readFile(join(root,'workspace/public-access/1.json'),'utf8'));
  assert.equal(saved.code.value,first.code,'the Web panel reads the same stored code');
  assert.deepEqual(JSON.parse((await run(['access-code'])).stdout),first,'asking again does not change it');
  await mkdir(join(root,'workspace/public-link'),{recursive:true});
  await writeFile(join(root,'workspace/public-link/1.json'),JSON.stringify({enabled:false}));
  await assert.rejects(run(['access-code']),/Public link is not running/,'a link turned Off gives no code');
});

test('without the runtime\'s provider a global notification setting gives no reminder', async t => {
  const root=await mkdtemp(join(tmpdir(),'chill-reminder-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  await saveMessageSetting('notifications', {...notifications,on:['comment']}, root);
  assert.equal(await notificationReminder({directory:root,goalId:'1',eventId:2,when:'comment'}), '');
});
