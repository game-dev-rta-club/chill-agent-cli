import {readFileSync,statSync} from 'node:fs';
import {dirname,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';

// A trusted application can ship an entry point without putting its policy in
// the generic host. The returned path belongs to this immutable runtime.
export function agentGuide(manifestUrl=new URL('../extensions.json',import.meta.url)) {
  let manifest;
  try { manifest=JSON.parse(readFileSync(manifestUrl,'utf8')); }
  catch(error) { if(error.code==='ENOENT')return null;throw error; }
  if(!manifest.agentGuide)return null;
  const name=manifest.agentGuide;
  if(typeof name!=='string'||isAbsolute(name)||/[\r\n\0]/.test(name))throw Error('Invalid agent guide path');
  const root=dirname(fileURLToPath(manifestUrl)),path=resolve(root,name),local=relative(root,path);
  if(local==='..'||local.startsWith('..'+(process.platform==='win32'?'\\':'/'))||isAbsolute(local)||!path.endsWith('.md'))throw Error('Agent guide must be a Markdown file inside the runtime');
  if(!statSync(path).isFile())throw Error('Agent guide is not a file');
  return path;
}
