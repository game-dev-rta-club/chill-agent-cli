#!/usr/bin/env node
import '../lib/quiet-sqlite-warning.mjs';
import {parseOptions, showHelp} from '../lib/cli-help.mjs';
import {watchClaudeIdle} from '../lib/claude-idle.mjs';
import {captureClaudeEntry, identifyClaudeCaller} from '../lib/claude-entry.mjs';
import {readClaudeConnectionStatus} from '../lib/claude-status.mjs';
import {requestClaudeAction,handleClaudeToolHook,inspectClaudeRequest} from '../lib/claude-actions.mjs';

async function main() {
  const args = process.argv.slice(2);
  if (showHelp('connection', args)) return;
  const [action, ...options] = args;
  const values=parseOptions(`connection ${action}`, options);
  if (action === 'show') {
    const caller=await identifyClaudeCaller();
    const status=await readClaudeConnectionStatus({...caller.identity,contextId:caller.contextId});
    console.log(JSON.stringify({...caller,status}, null, 2));
    return;
  }
  if(action==='request') {
    const result=await inspectClaudeRequest(values['--id'],{retry:values['--retry']===true});
    if(result.marker)console.log(result.marker);
    console.log(JSON.stringify(result));
    return;
  }
  if(['create-goal','inbox','activity'].includes(action)) {
    const payload=action==='create-goal'?{title:values['--title'],scope:values['--scope']||'',criteria:values['--criteria']||''}:
      action==='activity'?{eventId:Number(values['--event']),state:values['--state']}:{};
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
  if(action==='claude-watch') {
    const output=await watchClaudeIdle(input,{timeoutMs:values['--timeout-ms']===undefined?undefined:Number(values['--timeout-ms'])});
    if(output){console.error(output);process.exitCode=2;}
    return;
  }
  if(input?.hook_event_name==='SessionStart')await captureClaudeEntry(input);
  else {
    const output=await handleClaudeToolHook(input);
    if(output)console.log(JSON.stringify(output));
  }
}
main().catch(error => { console.error(`chill connection: ${error.message}`); process.exitCode = 1; });
