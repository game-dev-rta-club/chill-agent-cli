import {projectExtensionEnabled} from './project-workspace.mjs';
import {readFile,realpath} from 'node:fs/promises';
import {dirname,resolve,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

// Only composed, trusted runtime code may extend a native connection. Neither
// hook input, action payloads nor workspace files choose a module to execute.
export async function connectionExtensions(manifestUrl=new URL('../extensions.json',import.meta.url)) {
 if(process.env.CHILL_AGENT_EXTENSIONS==='none')return {};
 let manifest;
 try{manifest=JSON.parse(await readFile(manifestUrl,'utf8'));}catch(e){if(e.code==='ENOENT')return {};throw e;}
 const providers=manifest.connectionExtensions||{},result={};
 const root=await realpath(dirname(fileURLToPath(manifestUrl)));
 for(const [id,name] of Object.entries(providers)){
  if(!projectExtensionEnabled(id))continue;
  if(!/^[a-z][a-z0-9-]*$/.test(id)||typeof name!=='string'||isAbsolute(name)||!name.endsWith('.mjs'))throw Error('Invalid connection extension.');
  const path=await realpath(resolve(root,name)),local=relative(root,path);
  if(local==='..'||local.startsWith('..'+sep)||isAbsolute(local))throw Error('Connection extension must be inside the runtime.');
  result[id]=await import(pathToFileURL(path).href);
 }
 return result;
}
