import {browserThemeColor} from './public/theme-catalog.js';
import {readWorkspaceTheme,saveWorkspaceTheme} from './lib/workspace-theme.mjs';
import {join} from 'node:path';
import {writeJsonAtomically} from './lib/storage.mjs';
import {projectProfile,selectProjectPort,projectExtensionEnabled} from './lib/project-workspace.mjs';
import {createExtensionHost} from './lib/server-extensions.mjs';
import {registeredExtensions} from './lib/extension-registry.mjs';
import { showHelp } from './lib/cli-help.mjs';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {webSnapshot,webBrief} from './lib/web-snapshot.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { attachmentInfo, dataDirectory, initializeStore, listEventsSince, listGoals, readFeedback, readEvent, readConversationPage, saveAttachment, readBrief } from './lib/goal-store.mjs';
import {rootLetterSummary} from './public/letter-state.js';
import { recordServerUse, serverOptions, watchServerIdle } from './lib/server-lifecycle.mjs';
import { createTunnelController } from './lib/tunnel-controller.mjs';
import { readMessageSettings } from './lib/message-settings.mjs';
import {renderedEvent} from './lib/markdown.mjs';
import {goalSkills} from './lib/skill-catalog.mjs';
import {briefDocument,briefSVG} from './lib/brief.mjs';
import {readAgentStatus,saveAgentSettings,controlAgent,readGoalActivity} from './lib/agent-status.mjs';
import {readAgentPresence} from './lib/agent-presence.mjs';
import {goalCommentMarks} from './lib/agents/index.mjs';
import {readConnectedGoals} from './lib/workspace-reader.mjs';
import {createRuntimeUpdater} from './lib/runtime-update.mjs';
import {largeSize} from './lib/limits.mjs';
import {recordHidden} from './lib/hidden-failure.mjs';
import {createPublicAccess,sessionCookie,sessionFrom,codeAlphabet,deviceName} from './lib/public-access.mjs';

if (showHelp('foreground', process.argv.slice(2))) process.exit(0);

if(!process.env.PORT&&projectProfile())await selectProjectPort();
const { port, duration, idleTimeoutMs, tunnel, configured } = serverOptions(process.argv.slice(2));
const remote = configured ? (projectExtensionEnabled('public-link')?(await readMessageSettings()).remote:{mode:'off'}) : { mode: tunnel ? 'quick' : 'off' };
// launchd preserves this baseline across crash recovery. A manual start creates a new one.
const startedAt = Number(process.env.CHILL_AGENT_SERVER_STARTED_AT ?? Date.now());
if (!Number.isSafeInteger(startedAt) || startedAt <= 0) throw new Error('Invalid server start time.');
// Windows cannot signal a background server, so its service stops it over HTTP.
// Commands spawned by the server do not inherit the token.
const serviceToken = process.env.CHILL_AGENT_SERVICE_TOKEN || null;
delete process.env.CHILL_AGENT_SERVICE_TOKEN;
// Only writes can renew the idle deadline, so only writes hold it once it has
// passed. Reads never renew it: when Web stops, server.close() lets in-flight
// reads finish, so continuous polling can neither keep Web alive nor be cut off.
const renewing = request => !['GET','HEAD'].includes(request.method);
let activeWrites = 0, activeCommands = 0, stopIdleWatch;
let tunnelOrigin = null, closing = false;
const instanceToken=randomBytes(32).toString('hex');
const updates=createRuntimeUpdater({port:()=>server.address().port,duration});
const publicAccess=createPublicAccess();
const publicTunnel=createTunnelController({directory:dataDirectory(),port:()=>server.address().port,onOrigin:origin=>{tunnelOrigin=origin;}});
const extensions=createExtensionHost(registeredExtensions({tunnel:publicTunnel,access:publicAccess,configured}));
const allowedOrigin = request => request.headers.origin === `http://127.0.0.1:${server.address().port}`
  || (tunnelOrigin !== null && request.headers.origin === tunnelOrigin);

// Through the public link, only a device connected with the panel's access code sees anything.
function connectPage(response,nonce,{status=401,message=''}={}){
  // Under no-referrer, browsers send Origin: null when the form posts, and the gate would refuse it.
  response.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Referrer-Policy':'same-origin'});
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect · chill</title>
<style nonce="${nonce}">body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px system-ui,-apple-system,sans-serif;background:#f4f6f2;color:#243b3e}form{width:min(320px,calc(100vw - 32px));display:grid;gap:12px}h1{font-size:20px;margin:0}p{margin:0;color:#56655f;font-size:14px}input{font:600 22px ui-monospace,monospace;letter-spacing:.2em;text-transform:uppercase;padding:12px;border:1px solid #b9c4bd;border-radius:8px}button{font:600 16px system-ui,sans-serif;padding:12px;border:0;border-radius:8px;background:#2f5d50;color:#fff}.error{color:#a03a2c}</style>
<form method="post"><h1>Connect to chill</h1><p>Enter the 8-character access code shown in Public link on your computer.</p>${message?`<p class="error" role="alert">${message}</p>`:''}<input name="code" required autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="12" pattern="[${codeAlphabet}${codeAlphabet.toLowerCase()} -]{8,12}" aria-label="Access code" autofocus><button>Connect</button></form></html>`);
}
// Not connected, every page is the connect form. The form posts back to its own page,
// so after connecting the browser returns there with its #/goal/N.
async function publicGate(request,response,url,nonce){
  const localHost=`127.0.0.1:${server.address().port}`;
  if(request.headers.host===localHost&&!request.headers['cf-ray']&&!request.headers['cf-connecting-ip'])return false;
  if(await publicAccess.connected(sessionFrom(request)))return false;
  if(request.method==='POST'&&String(request.headers['content-type']||'').startsWith('application/x-www-form-urlencoded')){
    if(tunnelOrigin===null||request.headers.origin!==tunnelOrigin){sendJson(response,403,{error:'Connect from the public link.'});return true;}
    let code=null;try{code=new URLSearchParams((await readUpload(request)).toString()).get('code');}catch{}
    const session=await publicAccess.connect(code,{device:deviceName(request.headers['user-agent'])});
    if(!session){connectPage(response,nonce,{message:'That code is wrong, used or expired. Check the access code on your computer.'});return true;}
    response.writeHead(303,{'Set-Cookie':`${sessionCookie}=${session}; Path=/; Max-Age=34560000; HttpOnly; Secure; SameSite=Lax`,Location:url.pathname});
    response.end();return true;
  }
  if(request.method==='GET'&&(request.headers.accept||'').includes('text/html'))connectPage(response,nonce);
  else sendJson(response,401,{error:'Connect with the access code shown in Public link on your computer.'});
  return true;
}

function shutdown(preserveTunnel=false) {
  if (closing) return;
  closing = true;
  stopIdleWatch?.();
  void extensions.stop().catch(error=>console.error(error.message));
  void (preserveTunnel ? publicTunnel.release() : publicTunnel.stop()).catch(error => console.error(error.message));
  server.close();
}

// Fixed CLI commands handle input. Neither command nor chat ID comes from the browser.
const assets = new Map([
  ['/themes.css', ['themes.css', 'text/css; charset=utf-8']],
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/goals', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/vendor/workspace-app.js', ['vendor/workspace-app.js', 'text/javascript; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/activity-controls.js', ['activity-controls.js', 'text/javascript; charset=utf-8']],
  ['/agent-menu.js', ['agent-menu.js', 'text/javascript; charset=utf-8']],
  ['/agent-presence.js', ['agent-presence.js', 'text/javascript; charset=utf-8']],
  ['/extension-buttons.js', ['extension-buttons.js', 'text/javascript; charset=utf-8']],
  ['/browser-context.js', ['browser-context.js', 'text/javascript; charset=utf-8']],
  ['/confirmation-dialog.js', ['confirmation-dialog.js', 'text/javascript; charset=utf-8']],
  ['/runtime-update.js', ['runtime-update.js', 'text/javascript; charset=utf-8']],
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
    if (body.length > largeSize) throw new Error('Request is too large.');
  }
  return JSON.parse(body);
}

function acceptsGzip(request) {
  return (request.headers['accept-encoding'] || '').split(',').some(part => {
    const [name, ...parameters] = part.trim().toLowerCase().split(';');
    const quality = parameters.find(value => value.trim().startsWith('q='));
    return name.trim() === 'gzip' && (!quality || Number(quality.trim().slice(2)) > 0);
  });
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

async function readUpload(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > largeSize) throw new Error('File is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const server = createServer(async (request, response) => {
  const write = renewing(request);
  if (write) activeWrites += 1;
  let finished = false;
  const release = () => { if (!finished) { finished = true; if (write) activeWrites -= 1; } };
  response.once('finish', release);
  response.once('close', release);
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  // Existing sockets can pipeline more requests after server.close() has
  // cleared the listening address. Drain them without starting new work.
  if (closing) {
    response.setHeader('Connection', 'close');
    return sendJson(response, 503, {error:'The server is restarting. Please try again shortly.'});
  }
  const styleNonce=randomBytes(18).toString('base64');
  response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${styleNonce}'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'`);
  let path,url;
  try {
    url = new URL(request.url, 'http://localhost');path = url.pathname;
  } catch {
    response.writeHead(400);
    return response.end('Invalid request URL');
  }
  try{if(await publicGate(request,response,url,styleNonce))return;}
  catch(error){recordHidden('server.public-connect',error);return sendJson(response,503,{error:'Could not check the connection. Please try again.'});}
  if(path==='/api/service/shutdown'){
    // Only the local service may stop Web: browsers always send Origin or
    // Sec-Fetch-Site on a POST, and tunnelled requests carry Cloudflare headers.
    const supplied=Buffer.from(String(request.headers['x-chill-service']||'')),expected=Buffer.from(serviceToken||'');
    const local=request.socket.remoteAddress==='127.0.0.1'&&request.headers.host===`127.0.0.1:${server.address().port}`&&!request.headers.origin&&!request.headers['sec-fetch-site']&&!request.headers['cf-ray']&&!request.headers['cf-connecting-ip'];
    if(!serviceToken||request.method!=='POST'||!local||supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return sendJson(response,404,{});
    response.setHeader('Connection','close');sendJson(response,202,{stopping:true});
    console.log('Service stop requested. Stopping server.');shutdown();return;
  }
  if(path==='/api/workspace-instance')return sendJson(response,request.headers['x-chill-instance']===instanceToken?200:404,request.headers['x-chill-instance']===instanceToken?{token:instanceToken}:{});
  if(path==='/api/runtime-update'){
    // A device connected through the public link may update too: the
    // computer's version file alone names the package to switch to.
    if(request.method==='GET')return sendJson(response,200,{...await updates.status(),instance:startedAt});
    if(request.method!=='POST')return sendJson(response,405,{error:'Method not allowed.'});
    if(!allowedOrigin(request)||!request.headers['content-type']?.startsWith('application/json'))return sendJson(response,403,{error:'Only same-origin JSON requests are accepted.'});
    try{const result=await updates.start(await readJson(request));await recordServerUse(dataDirectory());return sendJson(response,202,result);}
    catch(error){return sendJson(response,409,{error:error.message});}
  }
  if(path==='/api/workspace/theme'){
    if(request.method==='GET')return sendJson(response,200,await readWorkspaceTheme());
    if(request.method!=='POST')return sendJson(response,405,{error:'Method not allowed.'});
    if(!allowedOrigin(request)||!request.headers['content-type']?.startsWith('application/json'))return sendJson(response,403,{error:'Only same-origin JSON requests are accepted.'});
    try{return sendJson(response,200,await saveWorkspaceTheme(await readJson(request)));}
    catch(error){return sendJson(response,400,{error:error.message});}
  }
  const extensionAsset=extensions.asset(path);
  if(extensionAsset&&['GET','HEAD'].includes(request.method)){
    try{const data=await readFile(extensionAsset.file);response.writeHead(200,{'Content-Type':extensionAsset.type,...(extensionAsset.scope==='/'?{'Service-Worker-Allowed':'/'}:{})});return response.end(request.method==='HEAD'?undefined:data);}
    catch{return sendJson(response,404,{error:'Extension asset unavailable.'});}
  }
  const extensionRequest=/^\/api\/extensions\/([a-z][a-z0-9-]*)\/([a-z0-9/-]+)$/.exec(path);
  if(extensionRequest&&['GET','POST'].includes(request.method)){
    if(request.method==='POST'&&(!allowedOrigin(request)&&!(request.headers['sec-fetch-site']==='same-origin'&&!request.headers.origin)||!request.headers['content-type']?.startsWith('application/json')))
      return sendJson(response,403,{error:'Only same-origin JSON requests are accepted.'});
    try{
      const localHost=`127.0.0.1:${server.address().port}`;
      const result=await extensions.request(extensionRequest[1],{method:request.method,path:extensionRequest[2],query:Object.fromEntries(url.searchParams),
        body:request.method==='POST'?await readJson(request):{},
        origin:request.headers.origin||(request.headers.host===localHost?`http://${localHost}`:tunnelOrigin),
        local:!request.headers['cf-connecting-ip']&&!request.headers['cf-ray']&&request.headers.host===localHost&&(!request.headers.origin||request.headers.origin===`http://${localHost}`)});
      return sendJson(response,result?.status||200,result?.body??result);
    }catch(error){return sendJson(response,error.status||400,{error:error.message});}
  }
  const extensionPath=/^\/api\/goals\/([1-9][0-9]*)\/extensions(?:\/([a-z][a-z0-9-]*))?$/.exec(path);
  if(extensionPath&&request.method==='GET'&&!extensionPath[2]){
    try{return sendJson(response,200,await extensions.controls(extensionPath[1],{activity:url.searchParams.get('activity')==='1',clientId:/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(url.searchParams.get('clientId')||'')?url.searchParams.get('clientId'):null}));}
    catch(error){recordHidden('server.extension-controls',error);return sendJson(response,503,{error:error.message});}
  }
  if(extensionPath&&request.method==='POST'&&extensionPath[2]){
    if(!allowedOrigin(request)||!request.headers['content-type']?.startsWith('application/json'))return sendJson(response,403,{error:'Only same-origin JSON requests are accepted.'});
    try{return sendJson(response,200,await extensions.change(extensionPath[1],extensionPath[2],await readJson(request),{activity:url.searchParams.get('activity')==='1'}));}
    catch(error){return sendJson(response,409,{error:error.message});}
  }
  const presencePath=/^\/api\/goals\/([1-9][0-9]*)\/agent\/presence$/.exec(path);
  if(presencePath&&request.method==='GET'){
    try{return sendJson(response,200,await readAgentPresence(presencePath[1]));}
    catch(error){recordHidden('server.agent-presence',error);return sendJson(response,503,{error:'Could not read Agent status.'});}
  }
  const skillsPath=/^\/api\/goals\/([1-9][0-9]*)\/skills$/.exec(path);
  if(skillsPath&&request.method==='GET'){
    try{return sendJson(response,200,await goalSkills(skillsPath[1]));}
    catch(error){return sendJson(response,error.message?.includes('not found')?404:500,{error:'Could not read skills.'});}
  }
  const agentPath=/^\/api\/goals\/([1-9][0-9]*)\/agent$/.exec(path);
  if(agentPath&&request.method==='GET') {
    try {return sendJson(response,200,await readAgentStatus(agentPath[1]));}
    catch(error) {recordHidden('server.agent-status',error);return sendJson(response,503,{error:'Could not read Agent information.'});}
  }
  if(agentPath&&request.method==='POST') {
    if(!allowedOrigin(request)||!request.headers['content-type']?.startsWith('application/json'))return sendJson(response,403,{error:'Only same-origin JSON requests are accepted.'});
    try{return sendJson(response,200,await saveAgentSettings(agentPath[1],await readJson(request)));}
    catch(error){return sendJson(response,409,{error:error.message});}
  }
  const activityPath=/^\/api\/goals\/([1-9][0-9]*)\/agent\/activity$/.exec(path);
  if(activityPath&&request.method==='GET'){
    try{return sendJson(response,200,await readGoalActivity(activityPath[1]));}
    catch(error){recordHidden('server.agent-activity',error);return sendJson(response,503,{error:'Could not read the agent.'});}
  }
  const controlPath=/^\/api\/goals\/([1-9][0-9]*)\/agent\/control$/.exec(path);
  if(controlPath&&request.method==='POST'){
    if(!allowedOrigin(request)||!request.headers['content-type']?.startsWith('application/json'))return sendJson(response,403,{error:'Only same-origin JSON requests are accepted.'});
    try{return sendJson(response,200,await controlAgent(controlPath[1],await readJson(request)));}
    catch(error){return sendJson(response,409,{error:error.message});}
  }
  const eventPath=/^\/api\/goals\/([1-9][0-9]*)\/events\/([1-9][0-9]*)$/.exec(path);
  if(eventPath&&request.method==='GET'){
    try{const event=await readEvent(Number(eventPath[2]));return event?.goalId===eventPath[1]?sendJson(response,200,renderedEvent(event)):sendJson(response,404,{error:'Event not found.'});}
    catch(error){return sendJson(response,400,{error:error.message});}
  }
  const conversationPath=/^\/api\/goals\/([1-9][0-9]*)\/conversation$/.exec(path);
  if(conversationPath&&request.method==='GET'){
    try{
      const before=url.searchParams.has('before')?Number(url.searchParams.get('before')):undefined;
      const limit=url.searchParams.has('limit')?Number(url.searchParams.get('limit')):30;
      const page=await readConversationPage(conversationPath[1],{before,limit});
      return sendJson(response,200,{...page,events:page.events.map(renderedEvent),answerTargets:page.answerTargets.map(renderedEvent)});
    }catch(error){return sendJson(response,error.status||400,{error:error.message});}
  }
  const lettersCountPath=/^\/api\/goals\/([1-9][0-9]*)\/letters\/count$/.exec(path);
  if(lettersCountPath&&request.method==='GET'){
    try{
      const [goals,conversation]=await Promise.all([listGoals(),readFeedback()]);
      const summary=rootLetterSummary(goals,conversation,lettersCountPath[1]);
      return sendJson(response,summary?200:404,summary||{error:'Goal not found.'});
    }catch{return sendJson(response,500,{error:'Could not count Letters.'});}
  }
  const briefSVGPath=/^\/api\/goals\/([1-9][0-9]*)\/(?:briefs|deliverables)\/([1-9][0-9]*)\/svg\/([0-9]+)$/.exec(path);
  if(briefSVGPath&&request.method==='GET'){
    try{
      const brief=await readBrief(briefSVGPath[1],Number(briefSVGPath[2]));
      const svg=brief?.format==='html'?briefSVG(brief.body,Number(briefSVGPath[3])):null;
      if(!svg)return sendJson(response,404,{error:'Deliverable image not found.'});
      response.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; sandbox");
      response.writeHead(200,{'Content-Type':'image/svg+xml; charset=utf-8'});
      return response.end(svg);
    }catch{return sendJson(response,500,{error:'Could not load Deliverable image.'});}
  }
  const briefDataPath=/^\/api\/goals\/([1-9][0-9]*)\/(?:briefs|deliverables)\/([1-9][0-9]*)$/.exec(path);
  if(briefDataPath&&request.method==='GET'){
    try{const brief=await readBrief(briefDataPath[1],Number(briefDataPath[2]));return sendJson(response,brief?200:404,brief?webBrief(brief):{error:'Deliverable not found.'});}
    catch{return sendJson(response,500,{error:'Could not load Deliverable.'});}
  }
  const briefDocumentPath=/^\/api\/goals\/([1-9][0-9]*)\/(?:briefs|deliverables)\/([1-9][0-9]*)\/document$/.exec(path);
  if(briefDocumentPath&&request.method==='GET') {
    try {
      const brief=await readBrief(briefDocumentPath[1],Number(briefDocumentPath[2]));
      if(!brief||brief.format!=='html')return sendJson(response,404,{error:'HTML Deliverable not found.'});
      response.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-same-origin");
      response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      return response.end(briefDocument(brief.body));
    } catch {return sendJson(response,500,{error:'Could not load HTML Deliverable.'});}
  }
  const feedbackPath = /^\/api\/goals\/([1-9][0-9]*)\/feedback$/.exec(path);
  const marksPath = /^\/api\/goals\/([1-9][0-9]*)\/comment-marks$/.exec(path);
  const sendNowPath = /^\/api\/goals\/([1-9][0-9]*)\/comments\/([1-9][0-9]*)\/send-now$/.exec(path);
  if (path === '/api/activity' && request.method === 'POST') {
    if (!allowedOrigin(request) || !request.headers['content-type']?.startsWith('application/json')) return sendJson(response, 403, { error: 'Only same-origin JSON requests are accepted.' });
    try { await readJson(request); await recordServerUse(dataDirectory()); return sendJson(response, 200, { ok: true }); }
    catch (error) { return sendJson(response, 400, { error: error.message }); }
  }
  if (sendNowPath && request.method === 'POST') {
    if (!allowedOrigin(request) || !request.headers['content-type']?.startsWith('application/json')) return sendJson(response, 403, { error: 'Only same-origin JSON requests are accepted.' });
    try {
      const marks = await goalCommentMarks(sendNowPath[1]);
      if (!marks.some(item => item.eventId === Number(sendNowPath[2]))) return sendJson(response, 404, { error: 'Comment not found.' });
      return callCli(['send-now', '--event', sendNowPath[2]], undefined, response, 'comment');
    } catch (error) { recordHidden('server.send-now', error); return sendJson(response, 500, { error: 'Could not send now.' }); }
  }
  if (path === '/api/images' && request.method === 'POST') {
    if (!allowedOrigin(request)) return sendJson(response, 403, { error: 'Only same-origin uploads are accepted.' });
    try {
      let name = '';
      try { name = decodeURIComponent(request.headers['x-file-name'] || ''); } catch { /* Keep the default name. */ }
      const image = await saveAttachment(await readUpload(request), request.headers['content-type'], name);
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
  if (marksPath) {
    try { return sendJson(response, 200, await goalCommentMarks(marksPath[1])); }
    catch (error) { recordHidden('server.comment-marks', error); return sendJson(response, 500, { error: 'Could not load comment marks.' }); }
  }
  const infoPath = /^\/api\/attachments\/([0-9a-f-]{36})$/.exec(path);
  if (infoPath) {
    const file = await attachmentInfo(infoPath[1]);
    if (!file) return sendJson(response, 404, { error: 'Attachment not found.' });
    return sendJson(response, 200, { id: file.id, mimeType: file.mimeType, name: file.name ?? null, image: !file.name });
  }
  const imagePath = /^\/api\/images\/([0-9a-f-]{36})$/.exec(path);
  if (imagePath) {
    const image = await attachmentInfo(imagePath[1]);
    if (!image) return sendJson(response, 404, { error: 'Attachment not found.' });
    const data = await readFile(image.path);
    // Images and PDFs open in the browser. Other files download, so an
    // attached HTML or script never runs inside the Web's origin.
    const headers = { 'Content-Length': data.length, 'X-Content-Type-Options': 'nosniff' };
    if (!image.name) headers['Content-Type'] = image.mimeType;
    else if (image.pdf) Object.assign(headers, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(image.name)}` });
    else Object.assign(headers, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(image.name)}` });
    response.writeHead(200, headers);
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
      const web=url.searchParams.get('view')==='web';
      const goals=await readConnectedGoals({render:!web,paged:web&&url.searchParams.get('history')==='paged'});
      let body = Buffer.from(JSON.stringify(web?webSnapshot(goals):goals));
      response.setHeader('Vary','Accept-Encoding');
      if(acceptsGzip(request)){body=gzipSync(body);response.setHeader('Content-Encoding','gzip');}
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
    if(asset[0]==='index.html'){const {theme}=await readWorkspaceTheme();data=Buffer.from(data.toString().replace('__STYLE_NONCE__',styleNonce).replace('__WORKSPACE_THEME__',theme).replace('__BROWSER_THEME_COLOR__',browserThemeColor(theme)));}
    if (request.method === 'GET' && asset[0] === 'index.html') await recordServerUse(dataDirectory());
    if(asset[0]!=='index.html'){
      const etag='W/"'+createHash('sha256').update(data).digest('hex')+'"';
      response.setHeader('Cache-Control','private, no-cache');response.setHeader('ETag',etag);
      response.setHeader('Vary','Accept-Encoding');
      if(request.headers['if-none-match']===etag){response.writeHead(304);return response.end();}
      if(acceptsGzip(request)){data=gzipSync(data);response.setHeader('Content-Encoding','gzip');}
    }
    response.writeHead(200, { 'Content-Type': asset[1] });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch {
    response.writeHead(500);
    response.end('Could not load the page asset');
  }
});

await initializeStore();
server.listen(port, '127.0.0.1', async () => {
  // Child CLI receipts must link to this server, including an OS-chosen port.
  process.env.PORT=String(server.address().port);
  if(projectProfile())try{await writeJsonAtomically(join(dataDirectory(),'runtime','endpoint.json'),{pid:process.pid,port:server.address().port,token:instanceToken});}catch(error){console.error(error.message);process.exitCode=1;shutdown();return;}
  void (async()=>{await extensions.start();if(remote.mode!=='off'&&!publicTunnel.initialized&&!closing)await publicTunnel.set(true,remote);})().catch(error=>{console.error(error.message);process.exitCode=1;shutdown();});
  console.log(`chill-agent: http://127.0.0.1:${server.address().port}`);
  console.log(`Idle timeout: ${duration} (user actions and CLI updates renew it; polling does not).`);
  stopIdleWatch = watchServerIdle({ directory: dataDirectory(), idleTimeoutMs, startedAt,
    isBusy: async () => activeWrites > 0 || activeCommands > 0 || await extensions.busy() || activeWrites > 0 || activeCommands > 0,
    canStop: () => activeWrites===0 && activeCommands===0 && !extensions.active,
    onIdle: () => { console.log(`Idle timeout reached (${duration}). Stopping server.`); shutdown(); },
  });

});
server.on('close', () => stopIdleWatch?.());
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Set PORT to another port.` : error.message);
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown());
}

process.on('SIGUSR2',()=>shutdown(true));
