import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { lastServerUse, serverOptions } from '../lib/server-lifecycle.mjs';
import { saveMessageSetting } from '../lib/message-settings.mjs';
import {fileURLToPath} from 'node:url';
import {usedChat} from './fake-codex-desktop.mjs';

const execute = promisify(execFile);
const serverFile = fileURLToPath(new URL('../server.mjs',import.meta.url));
const cli = fileURLToPath(new URL('../bin/chill-agent.mjs',import.meta.url));
const threadId = '00000000-0000-0000-0000-000000000001';

async function fixture(t, duration = '800ms', extra = {}, args = [], remote) {
  const root = await mkdtemp(join(tmpdir(), 'chill-idle-test-'));
  const env = { ...process.env, CHILL_AGENT_DATA_DIR: root, PORT: '0', CODEX_THREAD_ID:threadId,
    CHILL_AGENT_CODEX_PATH: fileURLToPath(new URL('./fake-codex.mjs',import.meta.url)) };
  delete env.CHILL_AGENT_SERVER_STARTED_AT;
  delete env.CHILL_AGENT_IDLE_TIMEOUT;
  Object.assign(env, extra);
  if (remote) await saveMessageSetting('remote', remote, root);
  const child = spawn(process.execPath, [serverFile, '--idle-timeout', duration, ...args], {env, stdio:['ignore','pipe','pipe']});
  const exited = once(child, 'exit');
  let output = '';
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
      if (match) resolve(match[0]);
    });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('exit', code => reject(new Error(`Exited before ready (${code}): ${output}`)));
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; });
  const url = await ready;
  // The CLI runs as the user's shell unless a test names the chat.
  const {CODEX_THREAD_ID:_chat,...shell}=env;
  const run = (args,extra={}) => execute(process.execPath, [cli, ...args], {env:{...shell,...extra}});
  return { root, child, url, env, exited, run, output: () => output };
}

test('idle timeout defaults to 3d, accepts startup overrides, and rejects ambiguous values', () => {
  assert.equal(serverOptions([], {}).idleTimeoutMs, 3 * 24 * 60 * 60 * 1000);
  assert.equal(serverOptions([], {CHILL_AGENT_IDLE_TIMEOUT:'2d'}).idleTimeoutMs, 172800000);
  assert.equal(serverOptions(['--idle-timeout','90m'], {CHILL_AGENT_IDLE_TIMEOUT:'2d'}).idleTimeoutMs, 5400000);
  assert.equal(serverOptions(['--idle-timeout','0.5h'], {}).idleTimeoutMs, 1800000);
  for (const value of ['0h','-1h','24','forever','NaNh','Infinityh','1.2ms','999999999999999999h']) {
    assert.throws(() => serverOptions(['--idle-timeout',value], {}), /positive duration/);
  }
  assert.throws(() => serverOptions(['--idle-timeout'], {}), /Usage/);
  assert.throws(() => serverOptions(['--other','1h'], {}), /Usage/);
  assert.equal(serverOptions(['--tunnel','--idle-timeout','12h'], {}).tunnel, true);
  assert.equal(serverOptions([], {}).tunnel, false);
  assert.throws(() => serverOptions(['--tunnel','--tunnel'], {}), /Usage/);
});

async function tunnelFixture(t, duration = '3s', extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'chill-connector-test-'));
  const binary = join(root, 'cloudflared');
  await writeFile(binary, `#!${process.execPath}
import {writeFileSync} from 'node:fs';
writeFileSync(process.env.CHILL_TEST_TUNNEL_PID, String(process.pid));
if (process.env.CHILL_TEST_TUNNEL_CRASH) {
  setTimeout(() => process.exit(2), 100);
} else {
  console.error('https://phone-test.trycloudflare.com');
  console.error('Registered tunnel connection');
  setInterval(() => {}, 1000);
}
`);
  await chmod(binary, 0o700);
  const pidFile = join(root, 'pid');
  const f = await fixture(t, duration, {CHILL_AGENT_CLOUDFLARED_PATH:binary,CHILL_TEST_TUNNEL_PID:pidFile,...extra}, ['--tunnel']);
  return {...f, pidFile, tunnelPath:join(f.root,'runtime',`web-${new URL(f.url).port}`,'tunnel.json')};
}

test('tunnel permits its exact origin for activity, images and feedback; idle stop removes URL and connector', {skip:process.platform==='win32'&&'the fake connector is a POSIX script; test/tunnel.test.mjs covers the Windows lookup',timeout:10000}, async t => {
  const f = await tunnelFixture(t);
  for (let i=0; i<100 && !f.output().includes('Tunnel:'); i++) await delay(20);
  const {url: origin, pid} = JSON.parse(await readFile(f.tunnelPath, 'utf8'));
  assert.equal(origin,'https://phone-test.trycloudflare.com');
  assert.equal(pid,f.child.pid);
  const headers = {Origin:origin,'Content-Type':'application/json'};
  assert.equal((await fetch(f.url + '/api/activity',{method:'POST',headers,body:'{}'})).status,200);
  for (const Origin of ['https://other.trycloudflare.com',origin+'.evil.test','null']) {
    assert.equal((await fetch(f.url+'/api/activity',{method:'POST',headers:{...headers,Origin},body:'{}'})).status,403);
  }
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5AAAAABJRU5ErkJggg==','base64');
  const uploaded = await fetch(f.url+'/api/images',{method:'POST',headers:{Origin:origin,'Content-Type':'image/png'},body:image});
  assert.equal(uploaded.status,201);
  const attachment = await uploaded.json();
  const body = join(f.root,'workspace/goals/1/deliverable.md');
  await f.run(['create','--title','Phone']);
  await writeFile(body,'<p>Phone</p>');
  await f.run(['deliverable','update','--id','1']);
  const saved = await fetch(f.url+'/api/goals/1/feedback',{method:'POST',headers,body:JSON.stringify({text:'Phone comment',attachmentIds:[attachment.id],annotations:[{kind:'text',text:'Phone note',anchor:{start:0,end:5,quote:'Phone'},source:{kind:'brief',version:1}}]})});
  assert.equal(saved.status,201);
  assert.equal((await saved.json()).feedback.text,'Phone comment');
  const connectorPid = Number(await readFile(f.pidFile,'utf8'));
  assert.equal((await f.exited)[0],0);
  assert.throws(() => process.kill(connectorPid,0),/ESRCH/);
  await assert.rejects(readFile(f.tunnelPath),{code:'ENOENT'});
});

test('manual shutdown also stops the connector; a connector failure keeps local Web available', {skip:process.platform==='win32'&&'the fake connector is a POSIX script; test/tunnel.test.mjs covers the Windows lookup',timeout:8000}, async t => {
  const f = await tunnelFixture(t,'1h');
  for (let i=0; i<100 && !f.output().includes('Tunnel:'); i++) await delay(20);
  const pid = Number(await readFile(f.pidFile,'utf8'));
  f.child.kill('SIGTERM');
  assert.equal((await f.exited)[0],0);
  assert.throws(() => process.kill(pid,0),/ESRCH/);
  await assert.rejects(readFile(f.tunnelPath),{code:'ENOENT'});
  const crashed = await tunnelFixture(t,'1h',{CHILL_TEST_TUNNEL_CRASH:'1'});
  await delay(300);
  assert.equal((await fetch(crashed.url)).status,200);
  assert.equal((await fetch(crashed.url+'/api/activity',{method:'POST',headers:{Origin:'https://phone-test.trycloudflare.com','Content-Type':'application/json'},body:'{}'})).status,403);
  crashed.child.kill('SIGTERM');await crashed.exited;
});

test('configured named tunnel uses Access ingress, accepts only its Origin, and closes with the server', {skip:process.platform==='win32'&&'the fake connector is a POSIX script; test/tunnel.test.mjs covers the Windows lookup',timeout:10000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'chill-named-connector-'));
  const binary = join(dir, 'cloudflared');
  const credentialsFile = join(dir, 'credentials.json');
  await writeFile(credentialsFile, '{}');
  await writeFile(binary, `#!${process.execPath}
import {readFileSync,writeFileSync} from 'node:fs';
const file=process.argv[process.argv.indexOf('--config')+1];
const config=JSON.parse(readFileSync(file,'utf8'));
if(process.argv.at(-2)!=='run'||config.ingress[0].originRequest.access.required!==true)process.exit(2);
writeFileSync(process.env.CHILL_TEST_TUNNEL_PID,String(process.pid));
console.error('Registered tunnel connection');
setInterval(()=>{},1000);
`);
  await chmod(binary,0o700);
  const remote={mode:'named',url:'https://plans.example.com',tunnelId:threadId,credentialsFile,accessTeam:'test',accessAud:['b'.repeat(64)]};
  const pidFile=join(dir,'pid');
  const f=await fixture(t,'1h',{CHILL_AGENT_CLOUDFLARED_PATH:binary,CHILL_TEST_TUNNEL_PID:pidFile},['--configured'],remote);
  for(let i=0;i<100&&!f.output().includes('Tunnel:');i++)await delay(20);
  assert.match(f.output(),/Tunnel: https:\/\/plans.example.com/);
  const post=origin=>fetch(f.url+'/api/activity',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'});
  assert.equal((await post(remote.url)).status,200);
  assert.equal((await post('https://plans.example.com.evil.test')).status,403);
  assert.equal((await post('https://phone-test.trycloudflare.com')).status,403);
  const pid=Number(await readFile(pidFile,'utf8'));
  f.child.kill('SIGTERM'); await f.exited;
  assert.throws(()=>process.kill(pid,0),/ESRCH/);
  await assert.rejects(readFile(join(f.root,'runtime',`web-${new URL(f.url).port}`,'tunnel.json')),{code:'ENOENT'});
  const local=await fixture(t,'1h',{CHILL_AGENT_CLOUDFLARED_PATH:'/missing/cloudflared'},['--local'],remote);
  assert.equal((await fetch(local.url)).status,200,'local mode needs no connector even if one was configured');
  assert.equal((await fetch(local.url+'/api/activity',{method:'POST',headers:{Origin:remote.url,'Content-Type':'application/json'},body:'{}'})).status,403);
});

test('background polling and invalid activity requests cannot keep an idle server alive', {timeout:30000}, async t => {
  // A deadline longer than a slow runner's first request keeps the check about
  // renewal, not about how fast the server and fetch start.
  const f = await fixture(t, '5s');
  let polls = 0, polling = true;
  // Each poll waits for the previous one, as a browser timer would, so a slow
  // runner does not pile requests up.
  void (async () => {
    while (polling) {
      try {
        await Promise.all(['/api/events','/api/goals'].map(path => fetch(f.url + path)));
        polls += 1;
      } catch { /* Expected after idle shutdown. */ }
      await delay(60);
    }
  })();
  t.after(() => { polling = false; });
  assert.equal((await fetch(f.url + '/api/activity', {method:'POST', headers:{Origin:'https://elsewhere.test','Content-Type':'application/json'}, body:'{}'})).status, 403);
  const [code, signal] = await f.exited;
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.ok(polls >= 2);
  assert.match(f.output(), /Idle timeout reached \(5s\)/);
});

test('reads that never pause cannot hold an expired deadline, and reads in flight still complete', {timeout:30000}, async t => {
  // Several readers keep a request in flight at every moment, as a slow
  // machine or many tabs can. Only the generous test timeout bounds the wait.
  const f = await fixture(t, '5s');
  let complete = 0, cutOff = 0, reading = true;
  const reader = async () => {
    while (reading) {
      let response;
      try { response = await fetch(f.url + '/api/goals'); } catch { break; /* Web has closed. */ }
      try { const body = await response.text(); if (response.status === 200) { JSON.parse(body); complete += 1; } }
      catch { cutOff += 1; }
    }
  };
  const readers = Promise.all(Array.from({length:4}, reader));
  t.after(() => { reading = false; });
  const [code, signal] = await f.exited;
  reading = false; await readers;
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.match(f.output(), /Idle timeout reached \(5s\)/);
  assert.ok(complete > 0);
  assert.equal(cutOff, 0, 'a read that started before shutdown returns its whole body');
});

test('opening the page, interaction and CLI mutations renew the idle deadline; CLI reads do not', {timeout:30000}, async t => {
  // The idle check reads the recorded last use, so renewal is checked there.
  // The deadline is far beyond any action, so a slow CLI start cannot stop Web
  // between actions; actual expiry is covered by the tests below.
  const f = await fixture(t, '1h');
  const body = join(f.root, 'body.html');
  await writeFile(body, '<p>TTL test</p>');
  const uses = [];
  for (const action of [
    () => fetch(f.url),
    () => fetch(f.url + '/api/activity', {method:'POST',headers:{Origin:f.url,'Content-Type':'application/json'},body:'{}'}),
    () => f.run(['create','--title','TTL']),
    () => f.run(['deliverable','update','--id','1']),
    () => f.run(['reply','--id','1','--text','Still working']),
  ]) {
    await delay(50); // distinct file times
    await action();
    uses.push(await lastServerUse(f.root, 0));
  }
  assert.ok(uses.every((time, i) => i === 0 || time > uses[i - 1]));
  await f.run(['show','--id','1']);
  await f.run(['check','--id','1']);
  assert.equal(await lastServerUse(f.root, 0), uses.at(-1));
  assert.equal(f.child.exitCode, null);
  assert.equal(JSON.parse((await f.run(['show','--id','1'])).stdout).conversation.find(event=>event.id===1).text, 'Still working');
});

test('idle expiry waits for an in-flight save, then allows the new idle period', {timeout:30000}, async t => {
  // Renew first, so a slow server start cannot use up the deadline, then hold a
  // save open until well after the renewed deadline has passed.
  const idle = 4000, f = await fixture(t, `${idle}ms`);
  assert.equal((await fetch(f.url + '/api/activity', {method:'POST',headers:{Origin:f.url,'Content-Type':'application/json'},body:'{}'})).status, 200);
  const renewed = await lastServerUse(f.root, 0);
  const { request } = await import('node:http');
  const response = new Promise((resolve, reject) => {
    const req = request(f.url + '/api/activity', {method:'POST',headers:{Origin:f.url,'Content-Type':'application/json'}}, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.write('{');
    setTimeout(() => req.end('}'), Math.max(0, renewed + idle + 1000 - Date.now()));
  });
  assert.equal(await response, 200);
  assert.ok(Date.now() > renewed + idle, 'the save outlived the deadline');
  assert.equal(f.child.exitCode, null, 'in-flight request survived the original deadline');
  assert.equal((await f.exited)[0], 0);
});

test('crash recovery keeps the original start deadline instead of granting another full lifetime', {timeout:15000}, async t => {
  const f = await fixture(t, '1h', {CHILL_AGENT_SERVER_STARTED_AT:String(Date.now() - 2 * 60 * 60 * 1000)});
  assert.equal((await f.exited)[0], 0);
  assert.match(f.output(), /Idle timeout reached \(1h\)/);
});

test('idle expiry waits for Codex notification even after the Web save receipt was returned', {skip:process.platform==='win32'&&'Codex Desktop harness is macOS-only; fake-codex.mjs runs as an executable',timeout:20000}, async t => {
  // Idle and queue delay leave room for a busy machine: setup steps must finish
  // before the server's own idle stop, and the queue must outlast that stop.
  const f = await fixture(t, '2s', {CHILL_TEST_QUEUE_DELAY:'3000'});
  // The user's own turn in Desktop, before its first tool: the comment waits in the Codex queue behind it.
  await usedChat(f.root,{turns:[{id:'00000000-0000-0000-0000-000000000077',status:'inProgress',completedAt:null}]});
  const body = join(f.root, 'body.html');
  await writeFile(body, '<p>Pending delivery</p>');
  await f.run(['create','--title','Pending delivery'],{CODEX_THREAD_ID:threadId});
  await f.run(['deliverable','update','--id','1']);
  const response = await fetch(f.url + '/api/goals/1/feedback', {method:'POST',
    headers:{Origin:f.url,'Content-Type':'application/json'},
    body:JSON.stringify({text:'Do not interrupt this notification'}),
  });
  assert.equal(response.status,201);
  assert.equal((await response.json()).feedback.changeId,1);
  await delay(2500);
  assert.equal(f.child.exitCode,null,'saved feedback is still being delivered');
  // Observe the durable receipt, rather than assuming process startup and the
  // delayed fake queue always finish within another fixed 1200 ms under load.
  const until = Date.now() + 6000;let queue = [];
  do {
    queue = JSON.parse(await readFile(join(f.root,'fake-queue.json'),'utf8').catch(() => '[]'));
    if (queue.length) break;
    await delay(100);
  } while (Date.now() < until);
  assert.equal(queue.length,1,'the idle chat was sent the comment');
  assert.equal(f.child.exitCode,null,'a message waiting in the Codex app also prevents idle shutdown');
  // The chat takes it and finishes its work.
  await writeFile(join(f.root,'fake-queue.json'),'[]');await usedChat(f.root);
  assert.equal((await f.exited)[0],0);
});

test('the Autonomy API saves the level of the Goal\'s Root agent apart from comments, rejects foreign origins and shows no extension switch', {timeout:8000}, async t=>{
 const f=await fixture(t,'1h');
 await f.run(['create','--title','Root']);
 await f.run(['create','--title','Child','--parent','1']);
 const set=(id,level,origin=f.url)=>fetch(`${f.url}/api/goals/${id}/autonomy`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({level})});
 const shown=async id=>(await (await fetch(`${f.url}/api/goals?view=web&history=paged`)).json()).find(g=>g.id===id).autonomy;
 assert.equal(await shown('1'),1);assert.equal(await shown('2'),1);
 assert.deepEqual((await (await fetch(`${f.url}/api/goals/2/extensions`)).json()).filter(c=>['continuation','approve-all'].includes(c.id)),[],'no AutoContinue or Approve all switch');
 assert.equal((await set('1',2,'https://foreign.example')).status,403);
 const saved=await set('1',2);assert.equal(saved.status,200);assert.deepEqual(await saved.json(),{goalId:'1',rootId:'1',autonomy:2});
 assert.equal(await shown('1'),2);assert.equal(await shown('2'),2,'every Goal of the tree shows the Root agent\'s level');
 assert.deepEqual(await (await set('2',3)).json(),{goalId:'2',rootId:'1',autonomy:3},'set on a child, it is the Root\'s');assert.equal(await shown('1'),3);
 assert.equal((await set('1',4)).status,400,'there are three levels');assert.equal((await set('1','2')).status,400);assert.equal((await set('99',2)).status,404);
 await f.run(['create','--title','Later child','--parent','1']);assert.equal(await shown('3'),3,'a new Goal shows its Root\'s level');
 await f.run(['create','--title','Other Root']);assert.equal(await shown('4'),1,'another Root has its own');
 assert.equal((await fetch(f.url+'/')).status,200);
 assert.equal((await fetch(`${f.url}/api/goals/1/extensions/continuation`,{method:'POST',headers:{Origin:f.url,'Content-Type':'application/json'},body:JSON.stringify({enabled:true,rootId:'1'})})).status,409,'the old switch API is gone');
});
