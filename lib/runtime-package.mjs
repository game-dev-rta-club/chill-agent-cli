import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { dataDirectory, writeJsonAtomically } from './goal-store.mjs';

// One allowlist for the distributable and its cache-independent runtime copy.
export async function runtimeFiles(root) {
  const files = ['package.json', 'npm-shrinkwrap.json', 'server.mjs', 'licenses/tabler-icons.txt', 'LICENSE'];
  async function collect(directory) {
    for (const entry of (await readdir(join(root, directory), {withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
      if (entry.name === 'node_modules') continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`Runtime cannot contain a symlink: ${path}`);
    }
  }
  try { await stat(join(root,'extensions.json')); files.push('extensions.json'); } catch(e) { if(e.code!=='ENOENT')throw e; }
  const lock = JSON.parse(await readFile(join(root, 'npm-shrinkwrap.json'), 'utf8'));
  for (const [path, dependency] of Object.entries(lock.packages)) {
    if (path.startsWith('node_modules/') && !dependency.dev) await collect(path);
  }
  try { await stat(join(root,'extensions')); await collect('extensions'); } catch(e) { if(e.code!=='ENOENT')throw e; }
  try { await stat(join(root,'skills')); await collect('skills'); } catch(e) { if(e.code!=='ENOENT')throw e; }
  await collect('public/vendor');
  for (const directory of ['bin', 'lib']) {
    for (const name of (await readdir(join(root, directory))).sort()) {
      if (name.endsWith('.mjs')) files.push(`${directory}/${name}`);
    }
  }
  files.push(...['index.html', 'styles.css', 'app.js', 'activity-controls.js', 'agent-menu.js', 'agent-presence.js', 'extension-buttons.js', 'browser-context.js', 'confirmation-dialog.js', 'work-ui.js', 'goal-view.js', 'goal-progress.js', 'goal-state.js', 'letter-state.js', 'brief-navigation.js', 'brief-body.js', 'markdown-view.js', 'conversation-window.js', 'workspace.css'].map(name => `public/${name}`));
  return files.sort();
}

export async function copyRuntime(root, target) {
  for (const file of await runtimeFiles(root)) {
    await mkdir(dirname(join(target, file)), { recursive: true });
    await copyFile(join(root, file), join(target, file));
  }
}

export async function prepareRuntime(root, directory = dataDirectory()) {
  const hash = createHash('sha256');
  for (const file of await runtimeFiles(root)) hash.update(file).update('\0').update(await readFile(join(root, file))).update('\0');
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
  const registration = { root: target, node: process.execPath, id };
  await writeJsonAtomically(join(runtime, 'installation.json'), registration);
  return { ...registration, launcher, dataDirectory: directory };
}
