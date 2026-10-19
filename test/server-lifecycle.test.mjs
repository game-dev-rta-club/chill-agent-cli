import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { connect } from 'node:net';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import {readFile} from './record-fixture.mjs';
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
  const run = args => execute(process.execPath, [cli, ...args], {env});
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

test('tunnel permits its exact origin for activity, images and feedback; idle stop removes URL and connector', {skip:process.platform==='win32'&&'the public link connector is macOS-only',timeout:10000}, async t => {
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

test('manual shutdown also stops the connector; a connector failure keeps local Web available', {skip:process.platform==='win32'&&'the public link connector is macOS-only',timeout:8000}, async t => {
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

test('the service token stops Web only from a local request that no browser can send', {timeout:8000}, async t => {
  const token = 'a'.repeat(64);
  const f = await fixture(t, '1h', {CHILL_AGENT_SERVICE_TOKEN:token});
  const stop = (headers, method = 'POST') => fetch(f.url + '/api/service/shutdown', {method, headers});
  for (const headers of [{}, {'x-chill-service':'b'.repeat(64)}, {'x-chill-service':token, Origin:f.url}, {'x-chill-service':token, 'Sec-Fetch-Site':'same-origin'}]) {
    assert.equal((await stop(headers)).status, 404);
  }
  assert.equal((await stop({'x-chill-service':token, 'cf-ray':'1'})).status, 401, 'a tunnelled request stops at sign-in');
  assert.equal((await stop({'x-chill-service':token}, 'GET')).status, 404);
  assert.equal((await stop({'x-chill-service':token})).status, 202);
  assert.deepEqual(await f.exited, [0, null]);
});

test('without a service token Web has no stop route', {timeout:8000}, async t => {
  const f = await fixture(t, '1h');
  assert.equal((await fetch(f.url + '/api/service/shutdown', {method:'POST', headers:{'x-chill-service':''}})).status, 404);
  assert.equal(f.child.exitCode, null);
});

test('restart drains an active connection and rejects a pipelined request without crashing', {skip:process.platform==='win32'&&'restart by SIGUSR2 is launchd-only',timeout:8000}, async t => {
  const f = await fixture(t, '1h');
  const socket = connect(Number(new URL(f.url).port), '127.0.0.1');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  let response = '';
  socket.on('data', chunk => { response += chunk; });
  const closed = once(socket, 'close');
  const ready = once(socket, 'data');
  socket.write(`POST /api/images HTTP/1.1\r\nHost: ${new URL(f.url).host}\r\nOrigin: ${f.url}\r\nContent-Type: image/png\r\nContent-Length: 2\r\nExpect: 100-continue\r\n\r\n`);
  await ready;
  assert.match(response, /100 Continue/);
  f.child.kill('SIGUSR2');
  await delay(100);
  socket.end(`xxPOST /api/activity HTTP/1.1\r\nHost: ${new URL(f.url).host}\r\nOrigin: ${f.url}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  await closed;
  assert.equal((await f.exited)[0], 0, f.output());
  assert.match(response, /503 Service Unavailable/);
  assert.doesNotMatch(f.output(), /TypeError/);
});

test('a request through the tunnel sees nothing until the phone signs in with the panel code', {skip:process.platform==='win32'&&'the public link connector is macOS-only',timeout:10000}, async t => {
  const f = await tunnelFixture(t,'1h');
  for (let i=0; i<100 && !f.output().includes('Tunnel:'); i++) await delay(20);
  const {url: origin} = JSON.parse(await readFile(f.tunnelPath, 'utf8'));
  const phone = {'cf-connecting-ip':'203.0.113.5'};
  const page = await fetch(f.url+'/', {headers:{...phone,Accept:'text/html'}});
  assert.equal(page.status,401);
  assert.match(await page.text(),/Sign in to chill/);
  assert.equal(page.headers.get('referrer-policy'),'same-origin','the form posts with its Origin, not null');
  assert.equal((await fetch(f.url+'/api/goals',{headers:phone})).status,401);
  assert.equal((await fetch(f.url+'/api/goals')).status,200,'the local Web needs no sign-in');
  const panel = async () => (await (await fetch(f.url+'/api/extensions/public-link/state?goalId=1')).json());
  const {code,qr} = await panel();
  assert.match(code,/^[2-9A-HJ-NP-Z]{8}$/);
  assert.ok(qr);
  assert.equal((await fetch(f.url+'/api/extensions/public-link/state?goalId=1',{headers:phone})).status,401);
  const form = (code,origin) => fetch(f.url+'/',{method:'POST',headers:{...phone,Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:`code=${code}`,redirect:'manual'});
  assert.equal((await form(code,'https://elsewhere.test')).status,403,'only the public link posts the form');
  const wrong = await form('22222222',origin);
  assert.equal(wrong.status,401);
  assert.match(await wrong.text(),/wrong, used or expired/);
  // The form posts back to its page, which the browser reopens with its #/goal/N.
  const signIn = await form(code.toLowerCase(),origin);
  assert.equal(signIn.status,303);
  assert.equal(signIn.headers.get('location'),'/');
  const cookie = signIn.headers.get('set-cookie');
  assert.match(cookie,/^chill_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/);
  const session = {...phone,Cookie:cookie.split(';')[0]};
  assert.equal((await fetch(f.url+'/api/goals',{headers:session})).status,200);
  assert.equal((await form(code,origin)).status,401,'a code works once');
  assert.notEqual((await panel()).code,code);
  assert.equal((await fetch(f.url+'/api/extensions/public-link/sign-out',{method:'POST',headers:{Origin:f.url,'Content-Type':'application/json'},body:'{}'})).status,200);
  assert.equal((await fetch(f.url+'/api/goals',{headers:session})).status,401,'signing out removes the phone');
});
test('configured named tunnel uses Access ingress, accepts only its Origin, and closes with the server', {skip:process.platform==='win32'&&'the public link connector is macOS-only',timeout:10000}, async t => {
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
    () => f.run(['comment','--id','1','--text','Still working']),
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
  assert.equal(JSON.parse(await readFile(join(f.root,'workspace','events','1.json'),'utf8')).text, 'Still working');
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
  await f.run(['create','--title','Pending delivery','--thread-id',threadId]);
  await f.run(['deliverable','update','--id','1']);
  const response = await fetch(f.url + '/api/goals/1/feedback', {method:'POST',
    headers:{Origin:f.url,'Content-Type':'application/json'},
    body:JSON.stringify({text:'Do not interrupt this notification'}),
  });
  assert.equal(response.status,201);
  assert.equal((await response.json()).feedback.changeId,1);
  await delay(2500);
  assert.equal(f.child.exitCode,null,'saved feedback is still being delivered');
  // Wait for the queue receipt rather than a fixed time, so a busy machine
  // does not fail the test; the server must stay up the whole time.
  let queue = [];
  for (let i = 0; i < 60; i++) {
    queue = JSON.parse(await readFile(join(f.root,'fake-queue.json'),'utf8').catch(() => '[]'));
    if (queue.length || f.child.exitCode !== null) break;
    await delay(100);
  }
  assert.equal(queue.length,1,'the idle chat was sent the comment');
  assert.equal(f.child.exitCode,null,'the server stayed up while it was sent');
  // A message waiting in the Codex app keeps the server up until the chat takes it.
  // The chat takes it and finishes its work.
  await writeFile(join(f.root,'fake-queue.json'),'[]');await usedChat(f.root);
  assert.equal((await f.exited)[0],0);
});
