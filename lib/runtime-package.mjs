import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { dataDirectory, writeJsonAtomically } from './goal-store.mjs';
import { stableNodePath } from './node-path.mjs';
import { recordSnapshotPackage, snapshotPackage } from './version-source.mjs';
import {largeSize} from './limits.mjs';

const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

// One allowlist for the distributable and its cache-independent runtime copy.
// Keys are paths inside the runtime; values are where each file is read from.
// Dependencies keep their lockfile paths in the runtime, but npm may have
// hoisted them above `root` when this package was installed as a dependency,
// so they are located the way Node resolves packages.
export async function runtimeSources(root) {
  const sources = new Map();
  for (const file of ['package.json', 'npm-shrinkwrap.json', 'server.mjs', 'licenses/tabler-icons.txt', 'LICENSE']) sources.set(file, join(root, file));
  async function collect(directory, from = join(root, directory)) {
    for (const entry of (await readdir(from, {withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
      if (entry.name === 'node_modules') continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await collect(path, join(from, entry.name));
      else if (entry.isFile()) sources.set(path, join(from, entry.name));
      else throw new Error(`Runtime cannot contain a symlink: ${path}`);
    }
  }
  async function exists(path) { try { return (await stat(path)).isDirectory(); } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
  async function locate(lockPath) {
    let base = root;
    for (const name of lockPath.slice('node_modules/'.length).split('/node_modules/')) {
      let found = null;
      for (let dir = base; ; dir = dirname(dir)) {
        if (await exists(join(dir, 'node_modules', name))) { found = join(dir, 'node_modules', name); break; }
        if (dirname(dir) === dir) break;
      }
      if (!found) throw new Error(`Runtime dependency is not installed: ${lockPath}`);
      base = found;
    }
    return base;
  }
  try { await stat(join(root,'extensions.json')); sources.set('extensions.json', join(root,'extensions.json')); } catch(e) { if(e.code!=='ENOENT')throw e; }
  const lock = JSON.parse(await readFile(join(root, 'npm-shrinkwrap.json'), 'utf8'));
  for (const [path, dependency] of Object.entries(lock.packages)) {
    if (path.startsWith('node_modules/') && !dependency.dev) await collect(path, await locate(path));
  }
  try { await stat(join(root,'extensions')); await collect('extensions'); } catch(e) { if(e.code!=='ENOENT')throw e; }
  try { await stat(join(root,'skills')); await collect('skills'); } catch(e) { if(e.code!=='ENOENT')throw e; }
  // The Claude Code mod chill places for the user (claude-setup.mjs); its tests stay in the repository.
  try { await stat(join(root,'claude-mods')); await collect('claude-mods'); } catch(e) { if(e.code!=='ENOENT')throw e; }
  for (const path of [...sources.keys()]) if (path.startsWith('claude-mods/') && path.endsWith('.test.ts')) sources.delete(path);
  await collect('public/vendor');
  // Modules only, including subfolders such as lib/agents.
  async function modules(directory) {
    for (const entry of (await readdir(join(root, directory), {withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await modules(path);
      else if (entry.isFile() && entry.name.endsWith('.mjs')) sources.set(path, join(root, path));
    }
  }
  for (const directory of ['bin', 'lib']) await modules(directory);
  for (const name of ['index.html', 'themes.css', 'theme-catalog.js', 'theme-menu.js', 'styles.css', 'app.js', 'activity-controls.js', 'agent-menu.js', 'agent-presence.js', 'extension-buttons.js', 'browser-context.js', 'confirmation-dialog.js', 'runtime-update.js', 'work-ui.js', 'goal-view.js', 'goal-progress.js', 'goal-state.js', 'letter-state.js', 'brief-navigation.js', 'brief-body.js', 'markdown-view.js', 'conversation-window.js', 'workspace.css']) sources.set(`public/${name}`, join(root, 'public', name));
  return new Map([...sources].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0));
}
export async function runtimeFiles(root) { return [...(await runtimeSources(root)).keys()]; }

export async function copyRuntime(root, target) {
  for (const [file, source] of await runtimeSources(root)) {
    await mkdir(dirname(join(target, file)), { recursive: true });
    await copyFile(source, join(target, file));
  }
}

export async function prepareRuntime(root, directory = dataDirectory(), { package: spec } = {}) {
  const hash = createHash('sha256');
  for (const [file, source] of await runtimeSources(root)) hash.update(file).update('\0').update(await readFile(source)).update('\0');
  const id = hash.digest('hex');
  const runtime = join(directory, 'runtime');
  const target = join(runtime, 'packages', id);
  await mkdir(join(runtime, 'packages'), { recursive: true });
  try { await stat(target); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const temporary = join(runtime, 'packages', `.pending-${randomUUID()}`);
    try {
      await copyRuntime(root, temporary);
      try { await rename(temporary, target); }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  // Stable hook/CLI entry. Active servers keep using their own immutable snapshot.
  const launcher = join(runtime, 'chill.mjs');
  const launcherSource = await readFile(join(root, 'bin', 'chill-launcher.mjs'));
  const temporaryLauncher = join(runtime, `.launcher-${randomUUID()}`);
  try {
    await writeFile(temporaryLauncher, launcherSource, { mode: 0o600 });
    await rename(temporaryLauncher, launcher);
  } finally { await rm(temporaryLauncher, { force: true }); }
  // One short command for hooks, agents and permission rules. It falls back to
  // the Node on PATH if the recorded one disappears, for example after an upgrade.
  const node = stableNodePath();
  const entry = join(runtime, 'chill');
  const temporaryEntry = join(runtime, `.entry-${randomUUID()}`);
  try {
    await writeFile(temporaryEntry, launcherScript(node), { mode: 0o700 });
    await rename(temporaryEntry, entry);
  } finally { await rm(temporaryEntry, { force: true }); }
  // Git Bash and Claude hooks use the entry above; PowerShell and cmd use this.
  // cmd reads batch files in the OEM code page, which cannot hold every Node
  // path, so this entry always uses the Node on PATH.
  if (process.platform === 'win32') {
    const temporaryCommand = join(runtime, `.entry-${randomUUID()}.cmd`);
    try {
      await writeFile(temporaryCommand, ['@echo off', 'where node >nul 2>nul || (echo chill: Node.js was not found on PATH. 1>&2 & exit /b 127)', 'node "%~dp0chill.mjs" %*', 'exit /b %errorlevel%', ''].join('\r\n'));
      await rename(temporaryCommand, join(runtime, 'chill.cmd'));
    } finally { await rm(temporaryCommand, { force: true }); }
  }
  // Remember which package spec produced this snapshot; reuse keeps the record.
  if (spec) await recordSnapshotPackage(directory, id, spec);
  const source = await snapshotPackage(directory, target);
  const registration = { root: target, node, id, ...(source ? { package: source } : {}) };
  await writeJsonAtomically(join(runtime, 'installation.json'), registration);
  return { ...registration, launcher, entry, dataDirectory: directory };
}

// Install another package with that package's own installer, in a separate
// process. A fix to what gets copied then takes effect in the same update,
// instead of only after the old installer has copied the new package once.
export async function prepareWithOwnInstaller(root, directory = dataDirectory(), options = {}, { run = promisify(execFile) } = {}) {
  const installer = join(root, 'lib', 'runtime-package.mjs');
  try { await stat(installer); } catch (error) { if (error.code === 'ENOENT') return prepareRuntime(root, directory, options); throw error; }
  // The new package also brings recorded Claude hooks up to its own version.
  const code = `const {prepareRuntime}=await import(process.argv[1]);const installed=await prepareRuntime(process.argv[2],process.argv[3],JSON.parse(process.argv[4]));
let hooks=[];try{const setup=await import(new URL('./claude-setup.mjs',process.argv[1]));if(setup.refreshRecordedClaudeHooks)hooks=await setup.refreshRecordedClaudeHooks({entry:installed.entry,directory:process.argv[3]});}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')hooks=[{error:error.message}];}
console.log(JSON.stringify({...installed,hooks}));`;
  const { stdout } = await run(process.execPath, ['--no-warnings', '--input-type=module', '-e', code, pathToFileURL(installer).href, root, directory, JSON.stringify(options)],
    { env: { ...process.env, CHILL_AGENT_DATA_DIR: directory }, timeout: 120000, maxBuffer: largeSize });
  return JSON.parse(stdout.trim().split('\n').at(-1));
}

// The shell entry. A Claude hook of a conversation marked quiet (claude-quiet)
// ends here, before Node starts. The session ID is the first field Claude Code
// writes, as {"session_id":"…",; input of any other shape, an ID other than
// letters, digits and hyphens, and every SessionStart go to Node.
export function launcherScript(node) {
  return [
    '#!/bin/sh',
    'chill_hook=',
    'case "$1 $2" in',
    "'connection claude-hook'|'connection claude-watch')",
    '  chill_hook=$(cat)',
    // Shell expansions only: no process starts on the way to a quiet exit.
    '  chill_session=${chill_hook%%,*}',
    `  case "$chill_session" in '{"session_id":"'*'"') chill_session=\${chill_session#'{"session_id":"'}; chill_session=\${chill_session%'"'} ;; *) chill_session= ;; esac`,
    `  case "$chill_session" in ''|*[!A-Za-z0-9-]*) chill_session= ;; esac`,
    '  [ ${#chill_session} -le 128 ] || chill_session=',
    `  case "$chill_hook" in *'"hook_event_name":"SessionStart"'*) chill_session= ;; esac`,
    '  [ -n "$chill_session" ] && [ -e "${0%/*}/../workspace/connections/quiet/$chill_session" ] && exit 0',
    '  ;;',
    'esac',
    `node=${shellQuote(node)}`,
    `[ -x "$node" ] || node=$(command -v node) || { echo 'chill: Node.js was not found. Run chill setup again.' >&2; exit 127; }`,
    // exec keeps Claude Code the parent of Node, which the watcher relies on.
    'if [ -n "$chill_hook" ]; then exec "$node" "$(dirname "$0")/chill.mjs" "$@" <<CHILL_HOOK_INPUT',
    '$chill_hook',
    'CHILL_HOOK_INPUT',
    'fi',
    'exec "$node" "$(dirname "$0")/chill.mjs" "$@"',
    '',
  ].join('\n');
}
