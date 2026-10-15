#!/usr/bin/env node
import '../lib/quiet-sqlite-warning.mjs';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {listGoals,workspaceDirectory} from '../lib/goal-store.mjs';
import {parseOptions, showHelp} from '../lib/cli-help.mjs';
import {waitForClaudeFeedback,waitResultText} from '../lib/claude-wait.mjs';
import {claudeRmGuard} from '../lib/claude-rm-guard.mjs';
import {claudePauseGuard} from '../lib/claude-pause.mjs';
import {claudePermissionDecision} from '../lib/claude-permissions.mjs';
import {captureClaudeEntry, identifyClaudeCaller} from '../lib/claude-entry.mjs';
import {readClaudeConnectionStatus} from '../lib/claude-status.mjs';
import {requestClaudeAction,requestClaudeJoin,handleClaudeToolHook,inspectClaudeRequest,claudeSessionStartContext} from '../lib/claude-actions.mjs';

async function main() {
  const args = process.argv.slice(2);
  if (showHelp('connection', args)) return;
  const [action, ...options] = args;
  const values=parseOptions(`connection ${action}`, options);
  if (action === 'show') {
    const {identity,contextId,observedAt,source}=await identifyClaudeCaller();
    const status=await readClaudeConnectionStatus({...identity,contextId});
    // Several conversations can share one project; name the Roots this one owns.
    // Read-only: a project without saved Goals is not created here.
    const roots=(existsSync(join(workspaceDirectory(),'workspace.sqlite'))?await listGoals():[]).filter(g=>!g.parentId&&g.connection?.sessionId===identity.sessionId&&g.connection.contextId===contextId)
      .map(({id,title,state})=>({id,title,state}));
    console.log(JSON.stringify({identity,contextId,observedAt,source,roots,status}, null, 2));
    return;
  }
  if(action==='join') {
    const request=await requestClaudeJoin();
    console.log(request.marker);
    console.log('Pending main-session hook confirmation. A shell receipt alone does not connect this conversation.');
    return;
  }
  if(action==='request') {
    const result=await inspectClaudeRequest(values['--id'],{retry:values['--retry']===true});
    if(result.marker)console.log(result.marker);
    console.log(JSON.stringify(result));
    return;
  }
  if(action==='wait') {
    // A stopped background task releases its refresh, so a new waiter starts at once.
    const controller=new AbortController();
    for(const name of ['SIGTERM','SIGINT','SIGHUP'])process.once(name,()=>controller.abort());
    console.log(waitResultText(await waitForClaudeFeedback({signal:controller.signal})));
    return;
  }
  if(['create-goal','adopt','inbox','activity','reply'].includes(action)) {
    const payload=action==='create-goal'?{title:values['--title'],scope:values['--scope']||'',criteria:values['--criteria']||''}:
      action==='adopt'?{goalId:values['--goal']}:
      action==='activity'?{eventId:Number(values['--event']),state:values['--state']}:
      action==='reply'?{eventId:Number(values['--event']),text:values['--text']??await readFile(values['--text-file'],'utf8')}:{};
    const request=await requestClaudeAction(action,payload);
    console.log(request.marker);
    console.log('Pending main-session hook confirmation. A shell receipt alone does not confirm this action.');
    return;
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 65536) throw Error('Claude hook input is too large.');
    chunks.push(chunk);
  }
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Error('Invalid Claude hook JSON.'); }
  if(input?.hook_event_name==='PermissionRequest') {
    const output=await claudePermissionDecision(input);
    if(output)console.log(JSON.stringify(output));
  } else if(input?.hook_event_name==='PreToolUse') {
    const output=await claudePauseGuard(input)??claudeRmGuard(input);
    if(output)console.log(JSON.stringify(output));
  } else if(input?.hook_event_name==='SessionStart') {
    const output=await claudeSessionStartContext(await captureClaudeEntry(input));
    if(output)console.log(JSON.stringify(output));
  } else {
    const output=await handleClaudeToolHook(input);
    if(output)console.log(JSON.stringify(output));
  }
}
main().catch(error => { console.error(`chill connection: ${error.message}`); process.exitCode = 1; });
