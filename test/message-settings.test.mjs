import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { namedTunnelConfig, readMessageSettings, saveMessageSetting, validateRemote } from '../lib/message-settings.mjs';
import { notificationReminder } from '../lib/notification-reminder.mjs';

const execute=promisify(execFile);
const remote={mode:'named',url:'https://plans.example.com',tunnelId:'00000000-0000-0000-0000-000000000001',credentialsFile:'/private/cloudflared/credential.json',accessTeam:'test-team',accessAud:['a'.repeat(64)]};
const notifications={enabled:true,tool:'slack-send',destination:'chosen-channel',on:['comment','letter']};

test('settings are optional, private, independently writable, and independently disabled',async t=>{
  const root=await mkdtemp(join(tmpdir(),'chill-settings-'));t.after(()=>rm(root,{recursive:true,force:true}));
  assert.deepEqual(await readMessageSettings(root),{remote:{mode:'off'},notifications:{enabled:false}});
  await Promise.all([saveMessageSetting('remote',remote,root),saveMessageSetting('notifications',notifications,root)]);
  assert.deepEqual(await readMessageSettings(root),{remote,notifications});
  assert.equal((await stat(join(root,'settings/remote.json'))).mode & 0o777,0o600);
  await saveMessageSetting('notifications',{enabled:false},root);
  assert.deepEqual((await readMessageSettings(root)).remote,remote);
  await saveMessageSetting('remote',{mode:'off'},root);
  assert.deepEqual(await readMessageSettings(root),{remote:{mode:'off'},notifications:{enabled:false}});
});

test('named tunnel uses exact HTTPS hostname and per-ingress Access verification; invalid settings do not replace good ones',async t=>{
  const root=await mkdtemp(join(tmpdir(),'chill-settings-validation-'));t.after(()=>rm(root,{recursive:true,force:true}));
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

test('notification preparation uses only a live configured URL and failures leave saved results intact',async t=>{
  const root=await mkdtemp(join(tmpdir(),'chill-notice-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const env={...process.env,CHILL_AGENT_DATA_DIR:root,PORT:'4173',CHILL_AGENT_CODEX_PATH:new URL('./fake-codex.mjs',import.meta.url).pathname};
  const run=(name,args)=>execute(process.execPath,[new URL(`../bin/${name}.mjs`,import.meta.url).pathname,...args],{env});
  await run('chill-agent',['create','--title','Saved result']);
  await run('chill-agent',['comment','--id','1','--text','Done']);
  const args=['notice','--id','1','--event','1'];
  assert.deepEqual(JSON.parse((await run('chill-settings',args)).stdout),{enabled:false});
  await saveMessageSetting('notifications',notifications,root);
  await saveMessageSetting('remote',remote,root);
  assert.equal(JSON.parse((await run('chill-settings',args)).stdout).url,null);
  const tunnel=join(root,'runtime/web-4173/tunnel.json'); await mkdir(join(root,'runtime/web-4173'),{recursive:true});
  await writeFile(tunnel,JSON.stringify({pid:process.pid,url:remote.url}));
  assert.equal(JSON.parse((await run('chill-settings',args)).stdout).url,`${remote.url}/#/goal/1`);
  await saveMessageSetting('remote',{mode:'off'},root);
  assert.equal(JSON.parse((await run('chill-settings',args)).stdout).url,null,'disabled exposure never advertises an old URL');
  const saved=await readFile(join(root,'workspace/events/1.json'),'utf8');
  await assert.rejects(run('chill-settings',['notice','--id','1','--event','999']));
  assert.equal(await readFile(join(root,'workspace/events/1.json'),'utf8'),saved);
});

test('reminders respect selected occasions without depending on remote settings or sending tools', async t => {
  const root=await mkdtemp(join(tmpdir(),'chill-reminder-'));t.after(()=>rm(root,{recursive:true,force:true}));
  assert.equal(await notificationReminder({directory:root}), '');
  await saveMessageSetting('notifications', {...notifications,on:['comment']}, root);
  await writeFile(join(root,'settings/remote.json'), '{bad remote config');
  assert.equal(await notificationReminder({directory:root,goalId:'1',eventId:2,when:'letter'}), '');
  const reminder=await notificationReminder({directory:root,goalId:'1',eventId:2,when:'comment'});
  assert.match(reminder,/notice --id 1 --event 2/);
  assert.doesNotMatch(reminder,/chosen-channel|slack-send/,'tool and recipient are looked up at send time, not frozen into context');
  await saveMessageSetting('notifications',{enabled:false},root);
  assert.equal(await notificationReminder({directory:root}), '');
});
