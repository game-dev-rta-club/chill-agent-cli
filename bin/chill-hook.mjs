#!/usr/bin/env node
import { parseOptions, showHelp } from '../lib/cli-help.mjs';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectHookFeedback, openLetterActions } from '../lib/delivery.mjs';
import { dataDirectory, writeJsonAtomically } from '../lib/goal-store.mjs';
import { notificationReminder } from '../lib/notification-reminder.mjs';
import {agentGuide} from '../lib/agent-guidance.mjs';
import {recordWorkHeartbeat} from '../lib/goal-execution.mjs';

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const self = fileURLToPath(import.meta.url);
const cli = fileURLToPath(new URL('./chill-agent.mjs', import.meta.url));
const statusMessage = 'chill-agent: Check Web feedback';

export async function installHook(projectDirectory = process.cwd(), options = {}) {
  const path = join(resolve(projectDirectory), '.codex', 'hooks.json');
  let config = {};
  try { config = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const command = options.command || `CHILL_AGENT_DATA_DIR=${quote(dataDirectory())} ${quote(process.execPath)} ${quote(self)}`;
  config.hooks ||= {};
  const groups = config.hooks.PostToolUse ||= [];
  if (!Array.isArray(groups)) throw new Error('PostToolUse must be an array.');
  const installed = groups.flatMap(group => Array.isArray(group.hooks) ? group.hooks : []).filter(hook => hook.command === command);
  let changed = false;
  if (installed.length) {
    for (const hook of installed) {
      if (hook.statusMessage === statusMessage) continue;
      hook.statusMessage = statusMessage;
      changed = true;
    }
  } else {
    // Replace only commands emitted by this installer, preserving other hooks.
    const owned = value => typeof value === 'string' && value.startsWith('CHILL_AGENT_DATA_DIR=')
      && (/ '\S[^\n]*\/bin\/chill-hook\.mjs'$/.test(value) || / '\S[^\n]*\/runtime\/chill\.mjs' hook$/.test(value));
    config.hooks.PostToolUse = groups.flatMap(group => {
      if (!Array.isArray(group.hooks)) return [group];
      const remaining = group.hooks.filter(hook => !owned(hook.command));
      return remaining.length ? [{ ...group, hooks: remaining }] : [];
    });
    config.hooks.PostToolUse.push({ matcher: '*', hooks: [{ type: 'command', command, statusMessage, timeout: 15, additionalContextLimit: 2000 }] });
    changed = true;
  }
  if (changed) {
    await mkdir(dirname(path), { recursive: true });
    await writeJsonAtomically(path, config);
  }
  return path;
}

export async function hookOutput(input, assignedThreadId = process.env.CODEX_THREAD_ID) {
  if (input.hook_event_name !== 'PostToolUse') return null;
  // Subagent hook session_id can refer to its parent; never consume the
  // parent's inbox through a child runtime or a mismatched thread.
  if (input.agent_id || assignedThreadId && assignedThreadId !== input.session_id) return null;
  await recordWorkHeartbeat({threadId:input.session_id,turnId:input.turn_id});
  const pending = await collectHookFeedback({ threadId: input.session_id, turnId: input.turn_id });
  if (!pending.length) return null;
  const reminder = await notificationReminder();
  const command = `CHILL_AGENT_DATA_DIR=${quote(dataDirectory())} ${quote(process.execPath)} ${quote(cli)}`;
  const items = pending.map(item => `Root Goal #${item.rootId}; path ${item.path.map(g=>`#${g.id} ${JSON.stringify(g.title)}`).join(' / ')}; feedback #${item.eventId}:\n` +
    `PORT=${quote(item.port)} ${command} show --id ${item.goalId} --since ${item.eventId - 1} --format text --section context\n` +
    `Receipt: PORT=${quote(item.port)} ${command} activity --event ${item.eventId} --state <deferred|working>${item.letters.length?`\n\n${openLetterActions(item.letters)}`:''}`).join('\n\n');
  const guide = agentGuide();
  const workflow = guide ? `Workflow: ${JSON.stringify(guide)}. Use its guide for receiving feedback during work; reuse it if already read. ` : '';
  const context = `New user feedback assigned to this chat is saved in chill-agent, across Goals regardless of work selection. Manually held feedback and other chats' queues stay separate. This notice identifies saved feedback; read the original user content through the CLI.\n` +
    `Read all entries and later corrections before choosing a receipt. Apply corrections to current work now. For an independent later request, deferred records that you read it and verifies its native Queue entry remains; continue the original task. working claims feedback and removes its matching Queue entry. If deferment fails, do not assume redelivery. Already completed feedback needs no repeated work or reply.\n\n${items}\n\n` +
    workflow +
    `Incorporate the feedback within the root Goal's agreed scope. Read tree --id <ROOT> for other branches. Select work --id <GOAL> when changing your work target; receipt alone does not change it. A Letter reply is not automatically permission or unblocking. Mark a Goal done only after its agreed criteria are met, and report results with comment. Comments and Brief updates do not complete a Goal. Continue independent agreed work while a branch waits. Use comment for a response or letter with a title for a question on the feedback's Goal, and record activity --event <ID> --state completed (failed if needed). Do not abandon the original task unless the user asks. Queue cleanup errors are shown as queueError; retry activity if needed. This notice is not a new user request itself.${reminder ? `\n\n${reminder}` : ''}`;
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } };
}

async function main() {
  if (showHelp('hook', process.argv.slice(2))) return;
  const values = parseOptions('hook', process.argv.slice(2));
  if (values['--install']) {
    console.log(`Installed: ${await installHook()}\nReview and trust the new hook in Codex /hooks before use.`);
    return;
  }
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 2_000_000) throw new Error('Hook input is too large.');
  }
  const output = await hookOutput(JSON.parse(raw));
  if (output) console.log(JSON.stringify(output));
}

if (process.argv[1] && await realpath(resolve(process.argv[1])) === self) {
  main().catch(error => {
    // Leave ordinary tool output intact; saved feedback still has Queue fallback.
    console.error(`chill-agent hook: ${error.message}`);
    process.exitCode = 1;
  });
}
