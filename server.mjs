import {readAgentActivity} from './lib/agent-activity.mjs';
import {createExtensionHost} from './lib/server-extensions.mjs';
import {registeredExtensions} from './lib/extension-registry.mjs';
import { showHelp } from './lib/cli-help.mjs';
import {randomBytes} from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { attachmentInfo, dataDirectory, initializeStore, listEventsSince, listStoredGoals, saveAttachment, readBrief } from './lib/goal-store.mjs';
import { listDeliveries, refreshWorkOutputs } from './lib/delivery.mjs';
import { recordServerUse, serverOptions, watchServerIdle } from './lib/server-lifecycle.mjs';
import { startTunnel } from './lib/tunnel.mjs';
import { readMessageSettings } from './lib/message-settings.mjs';
import {renderedEvent} from './lib/markdown.mjs';
import {briefDocument} from './lib/brief.mjs';
import {readAgentStatus,saveAgentSettings,controlAgent} from './lib/agent-status.mjs';
import {readAgentPresence} from './lib/agent-presence.mjs';
import {readConnectedGoals} from './lib/workspace-reader.mjs';

if (showHelp('foreground', process.argv.slice(2))) process.exit(0);

const { port, duration, idleTimeoutMs, tunnel, configured } = serverOptions(process.argv.slice(2));
const remote = configured ? (await readMessageSettings()).remote : { mode: tunnel ? 'quick' : 'off' };
// launchd preserves this baseline across crash recovery. A manual start creates a new one.
const startedAt = Number(process.env.CHILL_AGENT_SERVER_STARTED_AT ?? Date.now());
if (!Number.isSafeInteger(startedAt) || startedAt <= 0) throw new Error('Invalid server start time.');
let activeRequests = 0, activeCommands = 0, stopIdleWatch;
let tunnelOrigin = null, stopTunnel, closing = false;
const extensions=createExtensionHost(registeredExtensions());
const allowedOrigin = request => request.headers.origin === `http://127.0.0.1:${server.address().port}`
  || (tunnelOrigin !== null && request.headers.origin === tunnelOrigin);

function shutdown() {
  if (closing) return;
  closing = true;
  stopIdleWatch?.();
  void extensions.stop().catch(error=>console.error(error.message));
  void stopTunnel?.().catch(error => console.error(error.message));
  server.close();
}

// Fixed CLI commands handle input. Neither command nor chat ID comes from the browser.
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/goals', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/activity-controls.js', ['activity-controls.js', 'text/javascript; charset=utf-8']],
  ['/agent-menu.js', ['agent-menu.js', 'text/javascript; charset=utf-8']],
  ['/agent-presence.js', ['agent-presence.js', 'text/javascript; charset=utf-8']],
  ['/extension-buttons.js', ['extension-buttons.js', 'text/javascript; charset=utf-8']],
  ['/work-ui.js', ['work-ui.js', 'text/javascript; charset=utf-8']],
  ['/goal-view.js', ['goal-view.js', 'text/javascript; charset=utf-8']],
  ['/goal-progress.js', ['goal-progress.js', 'text/javascript; charset=utf-8']],
  ['/goal-state.js', ['goal-state.js', 'text/javascript; charset=utf-8']],
  ['/letter-state.js', ['letter-state.js', 'text/javascript; charset=utf-8']],
  ['/brief-navigation.js', ['brief-navigation.js', 'text/javascript; charset=utf-8']],
  ['/brief-body.js', ['brief-body.js', 'text/javascript; charset=utf-8']],
  ['/markdown-view.js', ['markdown-view.js', 'text/javascript; charset=utf-8']],
  ['/vendor/mermaid.js', ['vendor/mermaid.js', 'text/javascript; charset=utf-8']],
  ['/conversation-window.js', ['conversation-window.js', 'text/javascript; charset=utf-8']],
  ['/workspace.css', ['workspace.css', 'text/css; charset=utf-8']],
]);

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 160000) throw new Error('Request is too large.');
  }
  return JSON.parse(body);
}

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

function callCli(args, input, response, receipt, status = 200) {
  activeCommands += 1;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./bin/chill-agent.mjs', import.meta.url)), ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let responded = false, errorText = '';
  const finish = (code, data) => { if (!responded) { responded = true; sendJson(response, code, data); } };
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try { const data = JSON.parse(line); if (data[receipt]) {if (receipt === 'feedback') data.feedback = renderedEvent(data.feedback); finish(status, data);} } catch { /* Ignore non-receipt output. */ }
  });
  child.stderr.on('data', chunk => { if (errorText.length < 1000) errorText += chunk.toString().slice(0, 1000 - errorText.length); });
  child.stdin.on('error', () => {});
  child.on('error', () => finish(503, { error: 'Could not start the CLI.' }));
  const timer = setTimeout(() => {
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 1000);
    force.unref();
    child.once('exit', () => clearTimeout(force));
    finish(503, { error: 'The CLI timed out. Check the conversation before retrying.' });
  }, 45000);
  child.on('close', () => {
    activeCommands -= 1;
    clearTimeout(timer); lines.close();
    const code = /not found/i.test(errorText) ? 404 : 400;
    finish(code, { error: errorText.trim() || 'The CLI could not complete this request.' });
  });
  child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
}

async function readImage(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 5 * 1024 * 1024) throw new Error('Image is larger than 5 MB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const server = createServer(async (request, response) => {
  activeRequests += 1;
  let finished = false;
  const release = () => { if (!finished) { finished = true; activeRequests -= 1; } };
  response.once('finish', release);
  response.once('close', release);
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  const styleNonce=randomBytes(18).toString('base64');
  response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${styleNonce}'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'`);
  let path,url;
  try {
    url = new URL(request.url, 'http://localhost');path = url.pathname;
  } catch {
    response.writeHead(400);
    return response.end('Invalid request URL');
  }
  const extensionPath=/^\/api\/goals\/([1-9][0-9]*)\/extensions(?:\/([a-z][a-z0-9-]*))?$/.exec(path);
  if(extensionPath&&request.method==='GET'&&!extensionPath[2]){
    try{return sendJson(response,200,await extensions.controls(extensionPath[1],{activity:url.searchParams.get('activity')==='1'}));}
    catch(error){return sendJson(response,503,{error:error.message});}
  }
  if(extensionPath&&request.method==='POST'&&extensionPath[2]){
    if(!allowedOrigin(request)||!request.headers['content-type']?.startsWith('application/json'))return sendJson(response,403,{error:'Only same-origin JSON requests are accepted.'});
    try{return sendJson(response,200,await extensions.change(extensionPath[1],extensionPath[2],await readJson(request)));}
    catch(error){return sendJson(response,409,{error:error.message});}
  }
  const presencePath=/^\/api\/goals\/([1-9][0-9]*)\/agent\/presence$/.exec(path);
  if(presencePath&&request.method==='GET'){
    try{return sendJson(response,200,await readAgentPresence(presencePath[1]));}
    catch{return sendJson(response,503,{error:'Could not read Agent status.'});}
  }
  const agentPath=/^\/api\/goals\/([1-9][0-9]*)\/agent$/.exec(path);
  if(agentPath&&request.method==='GET') {
    try {return sendJson(response,200,await readAgentStatus(agentPath[1]));}
    catch {return sendJson(response,503,{error:'Could not read Agent information.'});}
  }
  if(agentPath&&request.method==='POST') {
    if(!allowedOrigin(request)||!request.headers['content-type']?.startsWith('application/json'))return sendJson(response,403,{error:'Only same-origin JSON requests are accepted.'});
    try{return sendJson(response,200,await saveAgentSettings(agentPath[1],await readJson(request)));}
    catch(error){return sendJson(response,409,{error:error.message});}
  }
  const activityPath=/^\/api\/goals\/([1-9][0-9]*)\/agent\/activity$/.exec(path);
  if(activityPath&&request.method==='GET'){
    try{return sendJson(response,200,await readAgentActivity(activityPath[1]));}
    catch{return sendJson(response,503,{error:'Could not read activity controls.'});}
  }
  const controlPath=/^\/api\/goals\/([1-9][0-9]*)\/agent\/control$/.exec(path);
  if(controlPath&&request.method==='POST'){
    if(!allowedOrigin(request)||!request.headers['content-type']?.startsWith('application/json'))return sendJson(response,403,{error:'Only same-origin JSON requests are accepted.'});
    try{return sendJson(response,200,await controlAgent(controlPath[1],await readJson(request)));}
    catch(error){return sendJson(response,409,{error:error.message});}
  }
  const briefDocumentPath=/^\/api\/goals\/([1-9][0-9]*)\/briefs\/([1-9][0-9]*)\/document$/.exec(path);
  if(briefDocumentPath&&request.method==='GET') {
    try {
      const brief=await readBrief(briefDocumentPath[1],Number(briefDocumentPath[2]));
      if(!brief||brief.format!=='html')return sendJson(response,404,{error:'HTML Brief not found.'});
      response.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-same-origin");
      response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      return response.end(briefDocument(brief.body));
    } catch {return sendJson(response,500,{error:'Could not load HTML Brief.'});}
  }
  const feedbackPath = /^\/api\/goals\/([1-9][0-9]*)\/feedback$/.exec(path);
  const deliveryPath = /^\/api\/goals\/([1-9][0-9]*)\/deliveries$/.exec(path);
  const retryPath = /^\/api\/goals\/([1-9][0-9]*)\/deliveries\/([1-9][0-9]*)\/retry$/.exec(path);
  if (path === '/api/activity' && request.method === 'POST') {
    if (!allowedOrigin(request) || !request.headers['content-type']?.startsWith('application/json')) return sendJson(response, 403, { error: 'Only same-origin JSON requests are accepted.' });
    try { await readJson(request); await recordServerUse(dataDirectory()); return sendJson(response, 200, { ok: true }); }
    catch (error) { return sendJson(response, 400, { error: error.message }); }
  }
  if (retryPath && request.method === 'POST') {
    if (!allowedOrigin(request) || !request.headers['content-type']?.startsWith('application/json')) return sendJson(response, 403, { error: 'Only same-origin JSON requests are accepted.' });
    try {
      const deliveries = await listDeliveries(retryPath[1]);
      if (!deliveries.some(item => item.eventId === Number(retryPath[2]))) return sendJson(response, 404, { error: 'Delivery not found.' });
      return callCli(['retry', '--event', retryPath[2]], undefined, response, 'delivery');
    } catch { return sendJson(response, 500, { error: 'Could not load delivery updates.' }); }
  }
  if (path === '/api/images' && request.method === 'POST') {
    if (!allowedOrigin(request)) return sendJson(response, 403, { error: 'Only same-origin uploads are accepted.' });
    try {
      const image = await saveAttachment(await readImage(request), request.headers['content-type']);
      return sendJson(response, 201, image);
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }
  if (feedbackPath && request.method === 'POST') {
    if (!allowedOrigin(request) || !request.headers['content-type']?.startsWith('application/json')) {
      return sendJson(response, 403, { error: 'Only same-origin JSON requests are accepted.' });
    }
    try {
      const input = await readJson(request);
      return callCli(['feedback', '--id', feedbackPath[1], '--input-file', '-'], input, response, 'feedback', 201);
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    return response.end('Method not allowed');
  }
  if (deliveryPath) {
    try {
      await refreshWorkOutputs(deliveryPath[1]);
      return sendJson(response, 200, await listDeliveries(deliveryPath[1]));
    }
    catch { return sendJson(response, 500, { error: 'Could not load delivery updates.' }); }
  }
  const imagePath = /^\/api\/images\/([0-9a-f-]{36})$/.exec(path);
  if (imagePath) {
    const image = await attachmentInfo(imagePath[1]);
    if (!image) return sendJson(response, 404, { error: 'Image not found.' });
    const data = await readFile(image.path);
    response.writeHead(200, { 'Content-Type': image.mimeType, 'Content-Length': data.length });
    return response.end(request.method === 'HEAD' ? undefined : data);
  }
  if (path === '/api/events') {
    try {
      const since = Number(new URL(request.url, 'http://localhost').searchParams.get('since') || 0);
      const delta = await listEventsSince(since);
      return sendJson(response, 200, {...delta, events:delta.events.map(renderedEvent)});
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }
  if (path === '/api/goals') {
    try {
      const body = JSON.stringify(await readConnectedGoals());
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      response.writeHead(500);
      return response.end('Could not load Goals');
    }
  }
  const asset = assets.get(path);
  if (!asset) {
    response.writeHead(404);
    return response.end('Not found');
  }
  try {
    let data = await readFile(fileURLToPath(new URL(`./public/${asset[0]}`, import.meta.url)));
    if(asset[0]==='index.html') data=Buffer.from(data.toString().replace('__STYLE_NONCE__',styleNonce));
    if (request.method === 'GET' && asset[0] === 'index.html') await recordServerUse(dataDirectory());
    response.writeHead(200, { 'Content-Type': asset[1] });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch {
    response.writeHead(500);
    response.end('Could not load the page asset');
  }
});

await initializeStore();
server.listen(port, '127.0.0.1', () => {
  // Child CLI receipts must link to this server, including an OS-chosen port.
  process.env.PORT=String(server.address().port);
  void extensions.start().catch(error=>{console.error(error.message);process.exitCode=1;shutdown();});
  console.log(`chill-agent: http://127.0.0.1:${server.address().port}`);
  console.log(`Idle timeout: ${duration} (user actions and CLI updates renew it; polling does not).`);
  stopIdleWatch = watchServerIdle({ directory: dataDirectory(), idleTimeoutMs, startedAt,
    isBusy: async () => activeRequests > 0 || activeCommands > 0 || await extensions.busy() || activeRequests > 0 || activeCommands > 0,
    canStop: () => activeRequests===0 && activeCommands===0 && !extensions.active,
    onIdle: () => { console.log(`Idle timeout reached (${duration}). Stopping server.`); shutdown(); },
  });
  if (remote.mode !== 'off' && !closing) {
    void startTunnel({ directory: dataDirectory(), port: server.address().port, remote,
      onOrigin: origin => { tunnelOrigin = origin; },
      onFailure: error => { console.error(error.message); process.exitCode = 1; shutdown(); },
    }).then(stop => { stopTunnel = stop; if (closing) return stop(); })
      .catch(error => { console.error(error.message); process.exitCode = 1; shutdown(); });
  }
});
server.on('close', () => stopIdleWatch?.());
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Set PORT to another port.` : error.message);
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, shutdown);
}
