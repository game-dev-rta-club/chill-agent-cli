import {lstat,readFile,realpath} from 'node:fs/promises';
import {basename,dirname,resolve} from 'node:path';

// A Git worktree is the same project as its main checkout: hosts such as Claude
// Desktop run a conversation in a linked worktree but load the main
// checkout's local settings, so both must share one store, Web and hooks.
// Only the top of a linked worktree is mapped; other paths stay as they are.
export async function projectRoot(path) {
  const root=await realpath(resolve(path));
  try {
    if(!(await lstat(`${root}/.git`)).isFile())return root;
    const pointer=/^gitdir:\s*(.+?)\s*$/m.exec(await readFile(`${root}/.git`,'utf8'))?.[1];
    if(!pointer)return root;
    const gitdir=resolve(root,pointer);
    const common=resolve(gitdir,(await readFile(`${gitdir}/commondir`,'utf8')).trim());
    // A bare repository has no main checkout to share.
    if(basename(common)!=='.git')return root;
    return await realpath(dirname(common));
  } catch { return root; }
}

// A hook's own directory and the conversation it reports belong together when
// they are the same folder or worktrees of the same repository.
export async function sameProject(a,b) {
  if(typeof a!=='string'||typeof b!=='string')return false;
  const [left,right]=await Promise.all([realpath(a),realpath(b)]);
  return left===right||await projectRoot(left)===await projectRoot(right);
}
