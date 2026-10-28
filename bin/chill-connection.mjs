#!/usr/bin/env node
import '../lib/quiet-sqlite-warning.mjs';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {listGoals,workspaceDirectory} from '../lib/goal-store.mjs';
import {parseOptions, showHelp} from '../lib/cli-help.mjs';
import {holdClaudeConversation,holdResultText,watchClaudeConversation,watcherWakeText} from '../lib/claude-wait.mjs';
import {claudeRmGuard} from '../lib/claude-rm-guard.mjs';
import {claudePauseGuard} from '../lib/claude-pause.mjs';
import {claudePermissionDecision} from '../lib/claude-permissions.mjs';
import {captureClaudeEntry, claudeEntryPaths, identifyClaudeCaller} from '../lib/claude-entry.mjs';
import {dataDirectory} from '../lib/data-directory.mjs';
import {readJson} from '../lib/storage.mjs';
import {reportClaudeHook} from '../lib/claude-agent-work.mjs';
import {claudeAskGuard,claudePlanApproval} from '../lib/claude-asks.mjs';
import {quietClaudeHook} from '../lib/claude-quiet.mjs';
import {readClaudeConnectionStatus} from '../lib/claude-status.mjs';
import {runClaudeAction,joinClaudeConversation,handleClaudeToolHook,claudeSessionStartContext} from '../lib/claude-actions.mjs';

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
    // The checks this conversation scheduled (connection wake), earliest first.
    const {pendingWakes}=await import('../lib/claude-wake.mjs');
    const record=await readJson(claudeEntryPaths(dataDirectory(),identity.sessionId).record);
    const wakes=record?.contextId===contextId?pendingWakes(record):[];
    console.log(JSON.stringify({identity,contextId,observedAt,source,roots,status,wakes}, null, 2));
    return;
  }
  if(action==='join') {
    console.log(await joinClaudeConversation());
    return;
  }
  if(action==='wake') {
    const {scheduleClaudeWake}=await import('../lib/claude-wake.mjs');
    console.log(JSON.stringify(await scheduleClaudeWake({minutes:values['--in']===undefined?undefined:Number(values['--in']),reason:values['--reason']||''}),null,2));
    return;
  }
  if(action==='wait') {
    // A stopped background task releases its hold, so a new one starts at once.
    const controller=new AbortController();
    for(const name of ['SIGTERM','SIGINT','SIGHUP'])process.once(name,()=>controller.abort());
    const result=await holdClaudeConversation({signal:controller.signal}),text=holdResultText(result);
    // A stalled task may still hold I/O that never settles: leave rather than wait for it.
    if(result.status==='stalled'){process.stdout.write(`${text}\n`,()=>process.exit(0));return;}
    console.log(text);
    return;
  }
  if(['create-goal','adopt','inbox','reply'].includes(action)) {
    const payload=action==='create-goal'?{title:values['--title'],scope:values['--scope']||'',criteria:values['--criteria']||''}:
      action==='adopt'?{goalId:values['--goal']}:
      action==='reply'?{goalId:values['--goal'],text:values['--text']??await readFile(values['--text-file'],'utf8'),...(values['--ask']!==undefined?{ask:values['--ask']}:{})}:{};
    console.log((await runClaudeAction(action,payload)).text);
    return;
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Error('Invalid Claude hook JSON.'); }
  if(action==='claude-watch') {
    // An asyncRewake hook: exit 2 makes Claude Code wake the model with stderr.
    if(input?.agent_id!=null||!['SessionStart','Stop'].includes(input?.hook_event_name)||typeof input.session_id!=='string')return;
    const controller=new AbortController();
    for(const name of ['SIGTERM','SIGINT','SIGHUP'])process.once(name,()=>controller.abort());
    // Claude Code is the parent; when it exits this process is reparented.
    const parent=process.ppid;
    const result=await watchClaudeConversation({sessionId:input.session_id,signal:controller.signal,attached:()=>process.ppid===parent}),text=watcherWakeText(result);
    if(result.status==='stalled'){process.stderr.write(`${text}\n`,()=>process.exit(2));return;}
    if(text){process.stderr.write(`${text}\n`);process.exitCode=2;}
    return;
  }
  // A conversation that never owned a Goal has nothing for its hooks to do.
  if(await quietClaudeHook(input))return;
  // Every main hook reports what the conversation is doing before it is handled.
  await reportClaudeHook(input);
  if(input?.hook_event_name==='PermissionRequest') {
    const output=await claudePlanApproval(input)??await claudePermissionDecision(input);
    if(output)console.log(JSON.stringify(output));
  } else if(input?.hook_event_name==='PreToolUse') {
    const output=await claudePauseGuard(input)??await claudeAskGuard(input)??claudeRmGuard(input);
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
