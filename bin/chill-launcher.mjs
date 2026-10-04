#!/usr/bin/env node
// This file is also copied to <data>/runtime/chill.mjs. Keep it dependency-free.
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

try {
  const runtime = dirname(fileURLToPath(import.meta.url));
  const directory = dirname(runtime);
  if (process.env.CHILL_AGENT_DATA_DIR && await realpath(resolve(process.env.CHILL_AGENT_DATA_DIR)) !== directory) throw new Error('This launcher belongs to a different data directory.');
  process.env.CHILL_AGENT_DATA_DIR = directory;
  const installed = JSON.parse(await readFile(join(runtime, 'installation.json'), 'utf8'));
  let [command, ...args] = process.argv.slice(2);
  if (!command || ['--help', '-h', 'help'].includes(command)) command = 'help';
  const entries = { help: 'bin/chill-help.mjs', goal: 'bin/chill-agent.mjs', server: 'bin/chill-server.mjs', hook: 'bin/chill-hook.mjs', settings: 'bin/chill-settings.mjs', monitor: 'bin/chill-monitor.mjs' };
  const extra=await readFile(join(installed.root,'extensions.json'),'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return {};throw e;});
  delete entries.monitor; Object.assign(entries,extra.commands||{});
  if (!Object.hasOwn(entries, command)) throw new Error('Unknown command. Use chill --help.');
  const entry = join(installed.root, entries[command]);
  process.argv = [process.execPath, entry, ...args];
  await import(pathToFileURL(entry).href);
} catch (error) { console.error(error.message); process.exitCode = 1; }
