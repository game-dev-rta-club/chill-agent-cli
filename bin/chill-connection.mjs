#!/usr/bin/env node
import '../lib/quiet-sqlite-warning.mjs';
import {readFile} from 'node:fs/promises';
import {parseOptions, showHelp} from '../lib/cli-help.mjs';
import {waitForClaudeFeedback,waitResultText} from '../lib/claude-wait.mjs';
import {captureClaudeEntry, identifyClaudeCaller} from '../lib/claude-entry.mjs';
import {readClaudeConnectionStatus} from '../lib/claude-status.mjs';
import {requestClaudeAction,handleClaudeToolHook,inspectClaudeRequest,claudeSessionStartContext} from '../lib/claude-actions.mjs';

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
  if(action==='wait') {
    console.log(waitResultText(await waitForClaudeFeedback()));
    return;
  }
  if(['create-goal','inbox','activity','reply'].includes(action)) {
    const payload=action==='create-goal'?{title:values['--title'],scope:values['--scope']||'',criteria:values['--criteria']||''}:
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
  if(input?.hook_event_name==='SessionStart') {
    const output=await claudeSessionStartContext(await captureClaudeEntry(input));
    if(output)console.log(JSON.stringify(output));
  } else {
    const output=await handleClaudeToolHook(input);
    if(output)console.log(JSON.stringify(output));
  }
}
main().catch(error => { console.error(`chill connection: ${error.message}`); process.exitCode = 1; });
