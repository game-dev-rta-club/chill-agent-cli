#!/usr/bin/env node
import '../lib/quiet-sqlite-warning.mjs';
// Optional plugin entry: find the prepared core without relying on plugin cache paths.
import { showHelp } from '../lib/cli-help.mjs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { dataDirectory } from '../lib/data-directory.mjs';

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.length === 1 && ['--help', '-h', 'help'].includes(args[0])) {
    showHelp('link', ['--help']);
    return;
  }
  const forwarded = args[0] === 'help' ? [...args.slice(1), '--help'] : args;
  if (!['settings', 'server'].includes(forwarded[0])) throw new Error('Usage: chill-link <settings|server> ...; add --help for details.');
  const runtime = join(dataDirectory(), 'runtime');
  let installed;
  try { installed = JSON.parse(await readFile(join(runtime, 'installation.json'), 'utf8')); }
  catch (error) {
    // Before setup the package can explain its interface. Once prepared, use
    // the actual core's help so a different addon version cannot describe it.
    if (error.code === 'ENOENT' && showHelp('link', forwarded)) return;
    throw error;
  }
  const child = spawn(installed.node, [join(runtime, 'chill.mjs'), ...forwarded], { stdio: 'inherit' });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}
main().catch(error => {
  console.error(error.code === 'ENOENT' ? 'Install and run the chill-agent core skill first, using the same CHILL_AGENT_DATA_DIR.' : error.message);
  process.exitCode = 1;
});
