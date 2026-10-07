import {realpath} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {dataDirectory,defaultDataDirectory} from './data-directory.mjs';
import {readJson,writeJsonAtomically,withStoreLock} from './storage.mjs';

export function projectProfile(directory=dataDirectory()) {
  try{
    const profile=JSON.parse(readFileSync(join(directory,'project.json'),'utf8'));
    if(profile.version!==1||typeof profile.path!=='string'||(profile.port!==undefined&&(!Number.isInteger(profile.port)||profile.port<1||profile.port>65535))||
      (profile.extensions!==undefined&&(!Array.isArray(profile.extensions)||profile.extensions.some(id=>!/^[-a-z0-9]+$/.test(id)))))throw Error('Invalid project profile.');
    return profile;
  }
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}
export function workspacePort(env=process.env) {
  return Number(env.PORT ?? projectProfile(env.CHILL_AGENT_DATA_DIR||defaultDataDirectory())?.port ?? 4173);
}
export async function projectDirectory(project,base=defaultDataDirectory()) {
  return join(base,'projects',createHash('sha256').update(await realpath(project)).digest('hex'));
}
export async function prepareProject(project,{base=defaultDataDirectory(),extensions}={}) {
  const path=await realpath(project),directory=await projectDirectory(path,base);
  await withStoreLock(join(directory,'locks','profile'),async()=>{
    const old=await readJson(join(directory,'project.json'));
    if(old&&old.path!==path)throw Error('Project directory identity mismatch.');
    if(extensions!==undefined&&(!Array.isArray(extensions)||extensions.some(id=>!/^[-a-z0-9]+$/.test(id))))throw Error('Invalid extension IDs.');
    await writeJsonAtomically(join(directory,'project.json'),{...old,version:1,path,...(extensions===undefined?{}:{extensions:[...new Set(extensions)]})});
  });
  await selectProjectPort(directory);
  return directory;
}
async function available(port) {
  return new Promise((resolve,reject)=>{
    const probe=createServer();probe.once('error',e=>e.code==='EADDRINUSE'?resolve(null):reject(e));
    probe.listen(port,'127.0.0.1',()=>{const chosen=probe.address().port;probe.close(()=>resolve(chosen));});
  });
}
export async function selectProjectPort(directory=dataDirectory(),{force=false}={}) {
  if(!projectProfile(directory))return null;
  return withStoreLock(join(directory,'locks','profile'),async()=>{
    const file=join(directory,'project.json'),profile=await readJson(file);
    const endpoint=await readJson(join(directory,'runtime','endpoint.json'));
    if(!force&&endpoint?.token&&Number.isInteger(endpoint.port)){
      try{
        const response=await fetch(`http://127.0.0.1:${endpoint.port}/api/workspace-instance`,{headers:{'x-chill-instance':endpoint.token},signal:AbortSignal.timeout(1000)});
        const live=await response.json();
        if(response.ok&&live.token===endpoint.token)return endpoint.port;
      }catch{}
    }
    const port=(!force&&profile.port&&await available(profile.port))||await available(0);
    await writeJsonAtomically(file,{...profile,port});return port;
  });
}

export function projectExtensionEnabled(id) {
  const selected=projectProfile()?.extensions;
  return process.env.CHILL_AGENT_EXTENSIONS!=='none'&&(!selected||selected.includes(id));
}

// Resolve before a CLI starts or contacts its project Web. Explicit overrides
// keep legacy behavior; an automatic port must not adopt a foreign listener.
export async function resolveWorkspacePort(env=process.env) {
  const directory=env.CHILL_AGENT_DATA_DIR||defaultDataDirectory();
  if(env.PORT===undefined&&projectProfile(directory))return selectProjectPort(directory);
  return workspacePort(env);
}
