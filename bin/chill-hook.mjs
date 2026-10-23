#!/usr/bin/env node
import '../lib/quiet-sqlite-warning.mjs';
import { parseOptions, showHelp } from '../lib/cli-help.mjs';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexCommand, codexStop, codexToolHook } from '../lib/agents/codex-work.mjs';
import { dataDirectory, validThreadId, writeJsonAtomically } from '../lib/goal-store.mjs';
import { quietGoalsReason } from '../lib/quiet-stop.mjs';
import {recordWorkHeartbeat} from '../lib/agents/codex-execution.mjs';
import { stableNodePath } from '../lib/node-path.mjs';
import {largeSize} from '../lib/limits.mjs';

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const self = fileURLToPath(import.meta.url);
const statusMessage = 'chill-agent: Check Web feedback';
const hookSpecs = {
  PostToolUse: { group: { matcher: '*' }, hook: { statusMessage, timeout: 15, additionalContextLimit: 2000 } },
  Stop: { group: {}, hook: { statusMessage: 'chill-agent: Check the user has heard back', timeout: 15 } },
};

export async function installHook(projectDirectory = process.cwd(), options = {}) {
  const path = join(resolve(projectDirectory), '.codex', 'hooks.json');
  let config = {};
  try { config = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const command = options.command || `CHILL_AGENT_DATA_DIR=${quote(dataDirectory())} ${quote(stableNodePath())} ${quote(self)}`;
  config.hooks ||= {};
  let changed = false;
  for (const [event, spec] of Object.entries(hookSpecs)) {
    const groups = config.hooks[event] ||= [];
    if (!Array.isArray(groups)) throw new Error(`${event} must be an array.`);
    const installed = groups.flatMap(group => Array.isArray(group.hooks) ? group.hooks : []).filter(hook => hook.command === command);
    if (installed.length) {
      for (const hook of installed) {
        if (hook.statusMessage === spec.hook.statusMessage) continue;
        hook.statusMessage = spec.hook.statusMessage;
        changed = true;
      }
      continue;
    }
    // Replace only commands emitted by this installer, preserving other hooks.
    const owned = value => typeof value === 'string' && value.startsWith('CHILL_AGENT_DATA_DIR=')
      && (/ '\S[^\n]*\/bin\/chill-hook\.mjs'$/.test(value) || / '\S[^\n]*\/runtime\/chill\.mjs' hook$/.test(value));
    config.hooks[event] = groups.flatMap(group => {
      if (!Array.isArray(group.hooks)) return [group];
      const remaining = group.hooks.filter(hook => !owned(hook.command));
      return remaining.length ? [{ ...group, hooks: remaining }] : [];
    });
    config.hooks[event].push({ ...spec.group, hooks: [{ type: 'command', command, ...spec.hook }] });
    changed = true;
  }
  if (changed) {
    await mkdir(dirname(path), { recursive: true });
    await writeJsonAtomically(path, config);
  }
  return path;
}

export async function hookOutput(input, assignedThreadId = process.env.CODEX_THREAD_ID) {
  if (!['PostToolUse', 'Stop'].includes(input.hook_event_name)) return null;
  // Subagent hook session_id can refer to its parent; never consume the
  // parent's inbox through a child runtime or a mismatched thread.
  if (input.agent_id || assignedThreadId && assignedThreadId !== input.session_id) return null;
  const threadId = validThreadId(input.session_id);
  if (input.hook_event_name === 'Stop') {
    const stop = await codexStop({ threadId, turnId: input.turn_id ?? null, text: input.last_assistant_message, transcript: input.transcript_path ?? null });
    if (stop?.feedback) return { decision: 'block', reason: stop.feedback };
    if (!stop?.quiet) return null;
    const command = codexCommand();
    return { decision: 'block', reason: quietGoalsReason(stop.quiet, {
      reply: `${command} comment --id <goalId> --text '<reply>'`,
      progress: `${command} comment --id <goalId> --text '<progress>'`,
    }) };
  }
  await recordWorkHeartbeat({threadId, turnId: input.turn_id});
  const context = await codexToolHook({ threadId, turnId: input.turn_id, limit: hookSpecs.PostToolUse.hook.additionalContextLimit, transcript: input.transcript_path ?? null });
  return context ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } } : null;
}

async function main() {
  if (showHelp('hook', process.argv.slice(2))) return;
  const values = parseOptions('hook', process.argv.slice(2));
  if (values['--install']) {
    console.log(`Installed: ${await installHook()}\nReview and trust the new hooks (PostToolUse and Stop) in Codex /hooks before use.`);
    return;
  }
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > largeSize) throw new Error('Hook input is too large.');
  }
  const output = await hookOutput(JSON.parse(raw));
  if (output) console.log(JSON.stringify(output));
}

if (process.argv[1] && await realpath(resolve(process.argv[1])) === self) {
  main().catch(error => {
    // Leave ordinary tool output intact; comments not handed stay saved for the next hook.
    console.error(`chill-agent hook: ${error.message}`);
    process.exitCode = 1;
  });
}
