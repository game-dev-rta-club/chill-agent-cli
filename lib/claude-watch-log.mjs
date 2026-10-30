import {appendFile,mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {dataDirectory} from './data-directory.mjs';
import {hidden} from './hidden-failure.mjs';

// Why each reply watcher ended. Most endings are silent and the watcher keeps
// no output, so a conversation that stopped receiving Web replies left nothing
// to explain it. One JSON line per start and per end; a start with no end means
// the process was killed without a chance to write one.
export const watcherLogPath=(directory=dataDirectory())=>join(directory,'workspace','connections','claude-code','watcher.log');
export const watcherLogBytes=256*1024;
export async function logWatcher(entry,{directory=dataDirectory(),now=Date.now,maxBytes=watcherLogBytes}={}) {
  const file=watcherLogPath(directory);
  try {
    await mkdir(dirname(file),{recursive:true});
    // Keep the newer half once the log grows past its limit.
    if(((await stat(file).catch(()=>null))?.size||0)>maxBytes){const lines=(await readFile(file,'utf8')).trimEnd().split('\n');await writeFile(file,`${lines.slice(Math.floor(lines.length/2)).join('\n')}\n`);}
    await appendFile(file,`${JSON.stringify({at:new Date(now()).toISOString(),...entry})}\n`);
  } catch(error) { hidden('claude-watch-log')(error); }
}
